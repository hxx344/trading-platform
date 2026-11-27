// DEX 价差实盘（docs/dexspread.md 第 13、18 节）：引擎按策略信号开平仓，在两腿都是下单场所（Lighter 主网、Lighter RH、Entropy）的配对上发真实的单。
// 实盘持仓就是策略持仓（没有模拟盘）。开仓信号 → 先下 A 腿、按 A 的实际成交量下 B 腿，B 没补齐的部分在 A 上反向平掉（单腿）；平仓信号 → 两腿各自只减仓平掉。
// 要点：
// - 每笔单发出前先把意图（pending）与「已走到哪一步」一起写进库；结果未知的单不重发，先按自编号查；查不出来就读账户：
//   持仓多出来了按多出的量记成交；持仓没变要等这笔单过期之后再读一次账户才算没成交（L039、L093）。
// - 所有动作串行：同一时刻只有一笔单在途。
// - 平不掉、结果一直未知或账户持仓与记录对不上时进入「停止」：不再开新仓，等人处理后在页面上恢复。
// - 账户应当专用：同一市场上有手动仓位会被当成对不上（L205）。
import type { KeyVenue } from '../dex/keys.ts';
import type { AccountSnapshot } from './accounts.ts';
import type { LighterPrivateStatus } from './lighter-private.ts';
import type { LiveKeys, LiveKeysStore } from './livekeys.ts';
import { VENUE_NAMES, type LegInfo, type MarketSpec, type PairInfo, type Regime, type Sample } from './model.ts';
import { ORDER_EXPIRY_MS, cloidOf, type OrderConfirmSource, type OrderOutcome, type ResolveOutcome, type VenueOrder, type VenueTrader } from './orders.ts';
import { floorTo, limitPrice, orderPlan } from './plan.ts';
import { FIRST_LEG_MISSED_NOTE, createLiveSummary, summaryRowOf } from './live-summary.ts';
import type { LiveSummaryRow } from './store.ts';
import type { Direction } from './strategy.ts';

export const LIVE_SETTINGS_KEY = 'liveSettings', LIVE_RUNTIME_KEY = 'liveRuntime';
export const LIVE_EXEC_KEY = 'liveExec', LIVE_SKIP_STATS_KEY = 'liveSkipStats';
export interface LiveLimits { /** 单笔名义（美元）。 */ perTradeUsd: number; /** 同时持有的实盘笔数。 */ maxOpen: number; /** 当日已实现亏损到这个数就不再开仓。 */ dailyLossUsd: number; /** 开仓对冲腿与平仓的限价保护（基点）。 */ slippageBps: number }
export interface LiveSettings { on: boolean; pairs: string[]; limits: LiveLimits }
export const DEFAULT_LIVE_SETTINGS: LiveSettings = { on: false, pairs: [], limits: { perTradeUsd: 100, maxOpen: 1, dailyLossUsd: 20, slippageBps: 30 } };
export const LIVE_LIMIT_RANGES = { perTradeUsd: [10, 100_000], maxOpen: [1, 20], dailyLossUsd: [1, 100_000], slippageBps: [1, 300] } as const;

export interface LiveExecSettings {
  /** 开仓 A 腿的限价滑点保护（基点，默认 2）；对冲 B 腿与平仓继续用 limits.slippageBps。 */
  openLegASlippageBps: number;
  /** 开仓信号持续确认毫秒数（默认 0 = 不延迟立即下单）。 */
  confirmMs: number;
  /** 第一腿未成交（not_filled）后的冷却秒数（默认 30）；真实成交与单腿仍按配对冷却分钟数。 */
  notFilledCooldownSec: number;
  /** 目标名义金额大于可用余额上限时，按 95% 可用上限自动向下调整单笔名义。 */
  autoSizeByBalance: boolean;
  /** 本地名义金额相对可用余额的倍率上限（默认 1，范围 1–5）；>1 时须先在交易所手动设好 >= 该倍率的杠杆并强制按 95% 预留缓冲。 */
  maxLeverage: number;
}
export const DEFAULT_LIVE_EXEC: LiveExecSettings = { openLegASlippageBps: 2, confirmMs: 0, notFilledCooldownSec: 30, autoSizeByBalance: true, maxLeverage: 1 };
export const LIVE_EXEC_RANGES = { openLegASlippageBps: [0, 30], confirmMs: [0, 10_000], notFilledCooldownSec: [5, 3_600], maxLeverage: [1, 5] } as const;

type LegName = 'a' | 'b';
type Side = 'buy' | 'sell';
export interface LiveLeg {
  venue: KeyVenue; /** 账户持仓里的代码（Entropy 带 io: 前缀）。 */ symbol: string; /** 开仓方向。 */ side: Side;
  /** 开仓成交量与成交额（数量 × 价格之和）。 */ qty: number; entryQuote: number;
  /** 已平掉的数量与成交额。 */ exitQty: number; exitQuote: number;
  feesUsd: number; /** 有成交价是按限价估的。 */ estimated: boolean;
  /** 开仓时的合约规格与代码：配对后来被移出目录时，平仓仍按它下单。 */ market?: MarketSpec; code?: string;
}
/** 开仓门槛上下文（来自引擎规则）：用于在提交前与发 A 腿前按最新盘口复算两腿实时价差与预期净利。 */
export interface LiveEntryCheck { entryBps: number; exitBps: number; slippageBps: number; minNetBps: number }
/** 开仓那一刻的策略读数（第 18、19 节）：引擎据此把实盘持仓还原成策略持仓来判断平仓与记录遥测。 */
export interface LiveStrategy {
  /** 实盘名义（美元）。 */ notionalUsd: number; /** 信号里的入场价差（基点）：两腿还没成交时用它。 */ entrySpread: number;
  entryBaseline: number; entryRegime: Regime; aFeeBps: number; bFeeBps: number; estimated: boolean;
  entryCostBps?: number;
  signalBbo?: { aBid: number; aAsk: number; bBid: number; bAsk: number; at: number };
  check?: LiveEntryCheck;
  /** 开仓时执行的保证金倍率上限（仅 > 1 时写入，保持 1× 下策略字段与旧版一致）。 */ maxLeverage?: number;
  /** 自动配置的配对：开仓时的出场、止损与最长持有，之后推荐值变了也不动这笔仓。 */ rules?: { exitBps: number; stopBps: number; maxHoldMinutes: number };
}
/** 开仓信号：方向、名义、持续确认时刻与策略读数。 */
export interface LiveSignal { direction: Direction; notionalUsd: number; signalAt?: number; check?: LiveEntryCheck; strategy: Omit<LiveStrategy, 'notionalUsd'> }
export interface PendingOrder {
  leg: LegName; purpose: 'open' | 'hedge' | 'flatten' | 'close'; side: Side; qty: number; limit: number; reduceOnly: boolean; clientId: number; sentAt: number;
  expectedPrice?: number; signalAt?: number;
}
export type LiveOrderRole = 'openA' | 'openB' | 'flatten' | 'closeA' | 'closeB';
export interface LiveOrderTelemetry {
  role: LiveOrderRole;
  leg: LegName;
  venue: KeyVenue;
  side: Side;
  clientId: number;
  qty: number;
  filledQty: number;
  expectedPrice: number | null;
  limitPrice: number;
  avgPrice: number | null;
  /** 逆向滑点（基点，正值为成交劣于预期价）；未成交或缺预期价时为 null。 */
  slippageBps: number | null;
  signalAt: number | null;
  sentAt: number;
  ackAt: number | null;
  confirmAt: number;
  confirmSource: OrderConfirmSource | 'account';
  status: string;
}
export interface LiveSkipStats { day: number; total: number; byReason: Record<string, number> }
export type LiveState = 'opening' | 'open' | 'closing' | 'stuck' | 'closed';
export interface LivePosition {
  id: string; /** 配对键。 */ symbol: string; /** v0.111.2 以前跟随的模拟持仓编号；v0.112.0 起写成持仓自己的编号，只为回滚时旧版本能认出并平掉，本版本不读。 */ paperId?: string; direction: Direction; ratio: number; state: LiveState;
  /** 开仓走到哪一步：a 下第一腿、b 下第二腿、settle 核对两腿并回补。 */ step: 'a' | 'b' | 'settle';
  openedAt: number; updatedAt: number; closedAt: number | null;
  a: LiveLeg; b: LiveLeg; /** 计划的 A 腿数量与限价；bLimit 是预演里 B 腿的限价，发第一腿前 B 的当前价不能比它差；expected 为 A 腿信号预期成交价。 */ plan: { qty: number; limit: number; bLimit?: number; expected?: number };
  pending: PendingOrder | null; /** 并发平仓时第二腿的在途意图。 */ pendingB?: PendingOrder | null;
  /** 回补或平仓已经发了几笔单。 */ tries: number; retryAt: number;
  closeReason: string | null; singleLeg: boolean; netUsd: number | null; note: string;
  /** 回补或平仓从什么时候起一直取不到报价（取到就清掉）。 */ waitSince?: number | null;
  closeSignalAt?: number | null;
  orders?: LiveOrderTelemetry[];
  strategy?: LiveStrategy;
}
export interface LiveStore {
  saveLive(position: LivePosition): void;
  saveLiveState?(key: string, value: unknown, at: number): void;
  saveLiveIntent?(runtimeKey: string, runtimeValue: unknown, position: LivePosition, at: number): void;
  liveActive(): LivePosition[];
  liveClosed(limit: number): LivePosition[];
  liveNetSince(time: number): number;
  liveTotals(): { trades: number; netUsd: number; wins: number };
  /** 最近若干笔有成交的已结束持仓，与全部已结束持仓的分组汇总（实盘页用；没有时页面少这几块）。 */
  liveTradedClosed?(limit: number): LivePosition[];
  liveSummaryRows?(): LiveSummaryRow[];
  state<T>(key: string): T | null;
  setState(key: string, value: unknown, at: number): void;
  event(at: number, kind: string, symbol: string | null, message: string): void;
}
export interface LiveDeps {
  /** 服务正在停止：不再推进、不再发单。 */ stopped?: () => boolean;
  store: LiveStore; keys: LiveKeysStore; now: () => number; log: (line: string) => void;
  /** 某场所当前凭据对应的下单连接器。 */ trader(venue: KeyVenue, keys: LiveKeys): VenueTrader;
  /** 签名器等前置条件缺什么（null 为齐全）。 */ venueProblem(venue: KeyVenue): string | null;
  pairOf(key: string): PairInfo | undefined;
  /** 一条腿此刻的一档（太旧时为 null）。 */ quote(leg: LegInfo): { bid: number; ask: number } | null;
  takerFeeBps(leg: LegInfo): number;
  /** 最近一次定时读到的账户。 */ account(venue: KeyVenue): { at: number; snapshot: AccountSnapshot } | null;
  /** 现读一次账户（核对结果未知的单时用）。 */ readAccount(venue: KeyVenue, signal: AbortSignal): Promise<AccountSnapshot>;
  /** Lighter / RH 私有订单 WS 状态。 */ privateStreams?: () => Partial<Record<'lighter' | 'rh', LighterPrivateStatus>>;
  /** 一笔实盘持仓结束了（含没开成、单腿、人工结束）：引擎据此冷却这个配对。抛错只记日志。 */ onFinished?: (position: LivePosition) => void;
  signalFor(): AbortSignal;
  /** 记录发出 Entropy 实盘单的关联信息（写盘失败只记日志，不阻止发单）。 */
  onOrderSent?: (info: { venue: KeyVenue; cloid: string; positionId: string; purpose: PendingOrder['purpose']; leg: LegInfo; assumedFeeBps: number; at: number }) => void;
  /** Entropy 实盘成交后触发一次延迟成本同步。 */
  onEntropyFill?: () => void;
}
export class LiveError extends Error { readonly code: string; readonly status: number; constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; } }

const MAX_FLATTEN_TRIES = 3, MAX_CLOSE_TRIES = 10, RETRY_MS = 5_000;
/** 实盘页的成交表列这么多笔；被挡下的统计最多这么久落一次库。 */
export const LIVE_TRADES_SHOWN = 50, SKIP_SAVE_MS = 1_000;
/** 结果未知的单：发出后过这么久还查不到，就按账户持仓核对；再久仍定不下来就停止。 */
const POSITION_CHECK_MS: Record<KeyVenue, number> = { entropy: 20_000, lighter: 60_000, rh: 60_000 };
const UNKNOWN_STUCK_MS = 15 * 60_000;
/** 开仓意图落库后这么久还没发出第一腿就作废（报价早已不是当时的）。 */
const INTENT_MAX_AGE_MS = 15_000;
/** 回补或平仓取不到报价：过这么久告警，再久就交给人处理。 */
const NO_QUOTE_ALERT_MS = 60_000, NO_QUOTE_STUCK_MS = 10 * 60_000;
/** 开仓被实盘检查挡住：同一配对同一原因这么久只记一条事件（信号每次推送都会再来）。 */
export const SKIP_EVENT_MS = 10 * 60_000;
/** 第二腿的意图一直落不了库：多久告警、多久转人工（计时只在内存里，进程重启从零开始）。 */
const HEDGE_FAIL_ALERT_MS = 60_000, HEDGE_FAIL_STUCK_MS = 10 * 60_000;
/** 单还没交给连接器就失败了（停止中、凭据不在、落自编号或意图失败）：这笔单肯定没发出，调用方可以退回进度。其余错误一律不能这样推断。 */
class NotSentError extends Error {}
/** 有实盘持仓而账户一直读不到：过这么久告警。 */
const ACCOUNT_BLIND_ALERT_MS = 10 * 60_000;
const ACCOUNT_FRESH_MS = 3 * 60_000, RECONCILE_MS = 60_000, RECONCILE_SETTLE_MS = 10_000;
const isKeyVenue = (venue: string): venue is KeyVenue => venue === 'lighter' || venue === 'rh' || venue === 'entropy';
const dayStart = (time: number) => Math.floor(time / 86_400_000) * 86_400_000;
const fmt = (value: number, digits: number) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const opposite = (side: Side): Side => side === 'buy' ? 'sell' : 'buy';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positionSymbol = (leg: LegInfo) => leg.venue === 'entropy' ? leg.market.coin ?? `io:${leg.symbol}` : leg.symbol;
const stepOf = (leg: LegInfo) => 10 ** -(leg.market.sizeDecimals ?? 0);
const remainingOf = (leg: LiveLeg) => leg.qty - leg.exitQty;

export function readLiveSettings(value: unknown, known: (key: string) => boolean): LiveSettings {
  const fail = (message: string): never => { throw new LiveError('invalid_params', message); };
  if (!isObject(value) || Object.keys(value).some(key => !['on', 'pairs', 'limits'].includes(key))) return fail('实盘设置格式无效');
  if (typeof value.on !== 'boolean') fail('实盘总开关须为布尔值');
  if (!Array.isArray(value.pairs) || value.pairs.length > 50 || value.pairs.some(key => typeof key !== 'string' || !known(key))) fail('实盘配对须为当前目录里的配对键（最多 50 个）');
  const raw = value.limits;
  if (!isObject(raw) || Object.keys(raw).some(key => !(key in LIVE_LIMIT_RANGES))) return fail('实盘限额格式无效');
  const limits = {} as LiveLimits;
  for (const [key, [low, high]] of Object.entries(LIVE_LIMIT_RANGES) as [keyof LiveLimits, readonly [number, number]][]) {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < low || number > high || (key === 'maxOpen' && !Number.isInteger(number))) fail(`实盘限额 ${key} 须在 ${low} 到 ${high} 之间`);
    limits[key] = number as number;
  }
  return { on: value.on as boolean, pairs: [...new Set(value.pairs as string[])].sort(), limits };
}

export function readLiveExecSettings(value: unknown, base: LiveExecSettings = DEFAULT_LIVE_EXEC): LiveExecSettings {
  const fail = (message: string): never => { throw new LiveError('invalid_params', message); };
  if (!isObject(value) || Object.keys(value).some(key => !(key in DEFAULT_LIVE_EXEC))) return fail('实盘执行优化设置格式无效');
  const next: LiveExecSettings = { ...base };
  for (const [key, [low, high]] of Object.entries(LIVE_EXEC_RANGES) as [keyof typeof LIVE_EXEC_RANGES, readonly [number, number]][]) {
    if (!(key in value)) continue;
    const raw = value[key];
    const integer = key === 'confirmMs' || key === 'notFilledCooldownSec';
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < low || raw > high || (integer && !Number.isInteger(raw))) {
      return fail(`实盘执行参数 ${key} 须在 ${low} 到 ${high} 之间`);
    }
    next[key] = raw;
  }
  if ('autoSizeByBalance' in value) {
    if (typeof value.autoSizeByBalance !== 'boolean') return fail('按余额自动缩量开关须为布尔值');
    next.autoSizeByBalance = value.autoSizeByBalance;
  }
  return next;
}

interface Runtime { halt: string | null; paused: Record<string, string>; singles: Record<string, number>; /** 用过的最大自编号：重启、时钟回拨后也不重号。 */ lastClientId?: number;
  /** 第几次停止：告警键用它，恢复后再因同样的原因停止也会重新通知。 */ haltSeq?: number }
const hashOf = (text: string) => { let hash = 5381; for (let index = 0; index < text.length; index++) hash = (hash * 33 ^ text.charCodeAt(index)) >>> 0; return hash.toString(36); };
const orderRoleOf = (pending: PendingOrder): LiveOrderRole =>
  pending.purpose === 'open' ? 'openA' : pending.purpose === 'hedge' ? 'openB' : pending.purpose === 'flatten' ? 'flatten' : pending.leg === 'a' ? 'closeA' : 'closeB';
function skipBucket(reason: string): string {
  if (reason.includes('可用余额')) return '可用余额不足';
  if (reason.includes('已越过限价')) return '价格已越过限价';
  if (reason.includes('实时价差偏离')) return '实时价差已缩窄';
  if (reason.includes('实时预期净利')) return '实时预期净利不足';
  return reason.replace(/\s*-?\d+(?:\.\d+)?/g, '').trim().slice(0, 48) || reason.slice(0, 48);
}
function normalizeSkipStats(raw: unknown, today: number): LiveSkipStats {
  if (!isObject(raw) || raw.day !== today || typeof raw.total !== 'number' || !Number.isFinite(raw.total) || raw.total < 0 || !isObject(raw.byReason)) {
    return { day: today, total: 0, byReason: {} };
  }
  const byReason: Record<string, number> = {};
  for (const [key, count] of Object.entries(raw.byReason)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) byReason[key] = count;
  }
  return { day: today, total: raw.total, byReason };
}
export interface LiveAlert { key: string; text: string }
/** 实盘检查挡下开仓的原因。attention 为 false：策略本来就会等的（已有持仓、腿被占用、持仓上限）或用户自己的设置（总开关、没勾选、带 Var 腿）；为 true：不处理就一直开不了（停止、暂停、凭据、签名器、账户读数、余额、当日亏损上限）。 */
export interface LiveBlock { reason: string; attention: boolean }
/** 一次页面读数里各配对共用的读数：凭据文件、各场所的前置检查、当日已实现各只取一次。 */
export interface BlockerMemo { keys?: ReturnType<LiveKeysStore['read']>; venues: Map<KeyVenue, string | null>; todayNet?: { day: number; value: number } }

export function createLiveTrader(deps: LiveDeps) {
  const { store, now, log } = deps;
  let settings: LiveSettings = (() => {
    const saved = store.state<LiveSettings>(LIVE_SETTINGS_KEY);
    // 存下来的配对可能已不在目录里：读设置时不按目录校验，开仓时再看。
    try { return saved ? readLiveSettings(saved, () => true) : DEFAULT_LIVE_SETTINGS; } catch { return DEFAULT_LIVE_SETTINGS; }
  })();
  let execSettings: LiveExecSettings = (() => {
    const saved = store.state<LiveExecSettings>(LIVE_EXEC_KEY);
    try { return saved ? readLiveExecSettings(saved) : DEFAULT_LIVE_EXEC; } catch { return DEFAULT_LIVE_EXEC; }
  })();
  let skipStats: LiveSkipStats = normalizeSkipStats(store.state<LiveSkipStats>(LIVE_SKIP_STATS_KEY), dayStart(now()));
  const runtime: Runtime = { halt: null, paused: {}, singles: {}, ...(store.state<Runtime>(LIVE_RUNTIME_KEY) ?? {}) };
  const active = new Map<string, LivePosition>();
  for (const position of store.liveActive()) active.set(position.id, position);
  const alerts: LiveAlert[] = [];
  let lastClientId = Math.max(0, Number(runtime.lastClientId) || 0, ...[...active.values()].flatMap(position => [position.pending?.clientId ?? 0, position.pendingB?.clientId ?? 0]));
  let sequence = 0, busy = false, lastSkip: { at: number; symbol: string; reason: string } | null = null;
  const skipEventAt = new Map<string, number>();
  let skipSavedAt = -Infinity, skipDirty = false;
  // 实盘页的累计与分组：启动时读一次，之后每结束一笔累加；成交列表到下一笔结束前不变，读一次留着。
  const summary = (() => {
    if (!store.liveSummaryRows) return null;
    // 读不出来不拦实盘启动：页面少结果计数与盈亏分组，累计退回每次读库。
    try { return createLiveSummary(store.liveSummaryRows()); } catch (error) { log(`varlighter: 实盘汇总读取失败，实盘页暂不显示结果计数与盈亏分组：${message(error)}`); return null; }
  })();
  let closedCache: { trades: LivePosition[]; tradedMore: LivePosition[] | undefined } | null = null;
  let lastOperationAt = now(), nextReconcile = now() + RECONCILE_MS, mismatchStreak = 0, blindSince: number | null = null;

  const saveRuntime = () => { try { (store.saveLiveState ?? store.setState)(LIVE_RUNTIME_KEY, runtime, now()); } catch (error) { log(`varlighter: 实盘运行状态保存失败：${message(error)}`); } };
  const event = (symbol: string | null, text: string) => { try { store.event(now(), 'live', symbol, text); } catch (error) { log(`varlighter: 实盘事件写入失败：${message(error)}`); } };
  function alert(key: string, text: string): void {
    if (alerts.some(item => item.key === key)) return;
    alerts.push({ key, text });
    if (alerts.length > 20) alerts.shift();
  }
  const haltAlert = (reason: string) => alert(`halt:${runtime.haltSeq ?? 0}:${hashOf(reason)}`, `【DEX 价差实盘已停止】${reason}。已有持仓仍会按平仓信号处理；核对交易所账户后在实盘页恢复`);
  const stuckAlert = (position: LivePosition) => alert(`stuck:${position.id}`, `【DEX 价差实盘】${position.symbol} 有一笔持仓需要人工处理：${position.note}`);
  function halt(reason: string): void {
    if (runtime.halt) return;
    runtime.halt = reason.slice(0, 200); runtime.haltSeq = (runtime.haltSeq ?? 0) + 1; saveRuntime();
    event(null, `实盘已停止开新仓：${reason}`);
    haltAlert(runtime.halt);
  }
  // 告警只在内存里：重启后把还没处理的停止与卡住的持仓重新报一次（键不变，执行服务那边不会重复发）。
  if (runtime.halt) haltAlert(runtime.halt);
  for (const position of active.values()) if (position.state === 'stuck') stuckAlert(position);
  const save = (position: LivePosition) => { position.updatedAt = now(); store.saveLive(position); };
  const title = (position: LivePosition) => position.symbol;
  /** 一条腿的合约规格：目录里有就用目录的，配对已被移出目录时用开仓时存下的。 */
  const legInfo = (position: LivePosition, name: LegName): LegInfo | null => {
    const current = deps.pairOf(position.symbol)?.[name];
    if (current) return current;
    const leg = position[name];
    return leg.market && leg.code ? { venue: leg.venue, symbol: leg.code, market: leg.market } : null;
  };
  /** 第一腿已成交、第二腿的意图一直落不了库：不能无限重试，一分钟告警，十分钟转人工（L039、L092）。 */
  const hedgeFailSince = new Map<string, number>();
  function hedgeBlocked(position: LivePosition, error: unknown): void {
    const since = hedgeFailSince.get(position.id) ?? now();
    hedgeFailSince.set(position.id, since);
    if (now() - since >= HEDGE_FAIL_STUCK_MS) { hedgeFailSince.delete(position.id); stuck(position, `第二腿一直没有发出（${message(error).slice(0, 80)}），第一腿没有对冲；修好后先在实盘页核对并处理这笔，再重启服务，否则重启后会按当时报价补发第二腿`); return; }
    if (now() - since >= HEDGE_FAIL_ALERT_MS) alert(`hedgefail:${position.id}`, `【DEX 价差实盘】${position.symbol} 第一腿已成交，第二腿 ${Math.round((now() - since) / 1000)} 秒仍没有发出（${message(error).slice(0, 80)}）；第一腿没有对冲，请检查服务器磁盘与日志`);
  }
  /** 一条腿此刻的可成交价是否在限价以内：买看卖一、卖看买一。不在或没有报价时返回原因。 */
  function quoteProblem(info: LegInfo, side: Side, limit: number): string | null {
    const quote = deps.quote(info);
    if (!quote) return `${VENUE_NAMES[info.venue]} 此刻没有报价`;
    const price = side === 'buy' ? quote.ask : quote.bid;
    if (!(Number.isFinite(limit) && limit > 0) || (side === 'buy' ? price > limit : price < limit)) return `${VENUE_NAMES[info.venue]} 此刻的${side === 'buy' ? '卖一' : '买一'} ${+price.toFixed(6)} 已越过限价 ${+limit.toFixed(6)}`;
    return null;
  }
  /** 回补或平仓取不到报价：一分钟后告警，十分钟后交给人处理。返回 true 表示已转人工。 */
  function waitQuote(position: LivePosition, venue: KeyVenue): boolean {
    const since = position.waitSince ??= now();
    if (now() - since >= NO_QUOTE_STUCK_MS) { stuck(position, `${VENUE_NAMES[venue]} 一直取不到报价，剩余持仓平不掉`); return true; }
    if (now() - since >= NO_QUOTE_ALERT_MS) alert(`noquote:${position.id}`, `【DEX 价差实盘】${position.symbol} 要平仓但 ${VENUE_NAMES[venue]} 取不到报价，已等 ${Math.round((now() - since) / 1000)} 秒；持仓还在交易所，请核对行情流与配对是否被停用`);
    position.retryAt = now() + RETRY_MS;
    save(position);
    return false;
  }

  function netOf(position: LivePosition): number {
    let net = 0;
    // 只算已平掉的部分（正常平仓时就是全部）；人工结束的持仓里没平掉的那部分不计。
    for (const leg of [position.a, position.b]) net += (leg.qty > 0 ? (leg.side === 'buy' ? 1 : -1) * (leg.exitQuote - leg.entryQuote * Math.min(1, leg.exitQty / leg.qty)) : 0) - leg.feesUsd;
    return net;
  }
  function finish(position: LivePosition, reason: string, note: string): void {
    position.state = 'closed'; position.closedAt = now(); position.closeReason = reason; position.netUsd = netOf(position);
    position.pending = null; position.pendingB = null;
    if (note) position.note = note;
    save(position);
    active.delete(position.id);
    closedCache = null;
    const row = summaryRowOf(position);
    if (row) summary?.add(row);
    const traded = position.a.qty > 0 || position.b.qty > 0;
    if (traded) event(position.symbol, `实盘平仓（${reason}）：净 ${fmt(position.netUsd, 2)} 美元${position.a.estimated || position.b.estimated ? '（部分成交价按限价估）' : ''}${note ? `，${note}` : ''}`);
    else event(position.symbol, `实盘未开成：${note || reason}`);
    if (position.singleLeg) {
      runtime.singles[position.symbol] = (runtime.singles[position.symbol] ?? 0) + 1;
      if (runtime.singles[position.symbol] >= 2) {
        runtime.paused[position.symbol] = '连续两次单腿';
        event(position.symbol, '连续两次单腿，已暂停这个配对的实盘');
        alert(`paused:${position.symbol}:${position.id}`, `【DEX 价差实盘】${position.symbol} 连续两次单腿，已暂停这个配对的实盘；在实盘页恢复`);
      }
      saveRuntime();
    } else if (traded && runtime.singles[position.symbol]) { delete runtime.singles[position.symbol]; saveRuntime(); }
    try { deps.onFinished?.(position); } catch (error) { log(`varlighter: 实盘结束后的冷却记录失败：${message(error)}`); }
    const today = store.liveNetSince(dayStart(now()));
    if (today <= -settings.limits.dailyLossUsd) alert(`loss:${dayStart(now())}`, `【DEX 价差实盘】当日已实现亏损 ${fmt(-today, 2)} 美元，达到上限 ${fmt(settings.limits.dailyLossUsd, 0)} 美元，今天不再开新仓`);
  }
  function stuck(position: LivePosition, reason: string): void {
    position.state = 'stuck'; position.note = reason.slice(0, 200);
    // 落库失败也要停下并告警（告警在内存里，库坏了也发得出去）。
    try { save(position); } catch (error) { log(`varlighter: 实盘 ${position.symbol} 转人工时保存失败：${message(error)}`); }
    event(position.symbol, `实盘持仓需要人工处理：${reason}`);
    stuckAlert(position);
    halt(`${title(position)} 需要人工处理：${reason}`);
  }

  function apply(position: LivePosition, slot: 'pending' | 'pendingB', pending: PendingOrder, outcome: Extract<OrderOutcome, { kind: 'done' }>, info: LegInfo, confirmSourceFallback: OrderConfirmSource | 'account'): void {
    // 成交量超过委托量的回报在进来之前已被拦下（sane），这里只是把容差内的零头收齐。
    const leg = position[pending.leg], filled = Math.max(0, Math.min(outcome.filledQty, pending.qty));
    const price = outcome.avgPrice ?? pending.limit;
    if (filled > 0) {
      if (outcome.avgPrice === null) leg.estimated = true;
      if (pending.purpose === 'open' || pending.purpose === 'hedge') { leg.qty += filled; leg.entryQuote += filled * price; }
      else { leg.exitQty += filled; leg.exitQuote += filled * price; }
      leg.feesUsd += filled * price * deps.takerFeeBps(info) / 10_000;
      if (leg.venue === 'entropy') {
        try { deps.onEntropyFill?.(); } catch (error) { log(`varlighter: 实盘触发 Entropy 成本同步失败：${message(error)}`); }
      }
    }
    const confirmAt = outcome.confirmAt ?? now();
    const slippageBps = filled > 0 && pending.expectedPrice && pending.expectedPrice > 0
      ? (pending.side === 'buy' ? price - pending.expectedPrice : pending.expectedPrice - price) / pending.expectedPrice * 1e4
      : null;
    (position.orders ??= []).push({
      role: orderRoleOf(pending),
      leg: pending.leg,
      venue: leg.venue,
      side: pending.side,
      clientId: pending.clientId,
      qty: pending.qty,
      filledQty: filled,
      expectedPrice: pending.expectedPrice ?? null,
      limitPrice: pending.limit,
      avgPrice: outcome.avgPrice,
      slippageBps,
      signalAt: pending.signalAt ?? null,
      sentAt: pending.sentAt,
      ackAt: outcome.ackAt ?? null,
      confirmAt,
      confirmSource: outcome.confirmSource ?? confirmSourceFallback,
      status: outcome.note,
    });
    position[slot] = null;
    lastOperationAt = now();
    // 落库失败不往外抛：单已经发出并成交，往外抛会被当成「没发出」退回进度、再发一遍。内存里已经记了这笔成交，下一次保存会补上；
    // 进程此刻退出的话库里还留着 pending，重启后重新查一次，不会重发也不会记两遍（L212）。
    try { save(position); } catch (error) { log(`varlighter: 实盘 ${position.symbol} 记成交时保存失败，下一次保存补上：${message(error)}`); }
    log(`varlighter: 实盘 ${position.symbol} ${VENUE_NAMES[leg.venue]} ${pending.purpose} ${pending.side} ${pending.qty}：成交 ${filled}，${outcome.note}`);
  }

  interface SendSpec { slot: 'pending' | 'pendingB'; info: LegInfo; order: Omit<PendingOrder, 'clientId' | 'sentAt'> }
  /** 原子持久化一到两笔意图后发出（平仓双腿并发，开仓单腿顺序）；任一腿返回 unknown 时保留对应槽位等下一轮查单。 */
  async function sendBatch(position: LivePosition, specs: readonly SendSpec[], beforeCommit?: () => void, rollback?: () => void): Promise<boolean> {
    const keys = deps.keys.read().keys;
    for (const spec of specs) {
      const venue = position[spec.order.leg].venue;
      if (!keys[venue]) throw new NotSentError(`${VENUE_NAMES[venue]} 的凭据已不在`);
    }
    // 服务正在停止：不落意图、不发（信号已经中止，发出去也只会被记成结果未知）。
    if (deps.stopped?.()) throw new NotSentError('服务正在停止');
    const at = now();
    const committed = specs.map(spec => {
      const pend: PendingOrder = { ...spec.order, clientId: lastClientId = Math.max(lastClientId + 1, at), sentAt: at };
      return { ...spec, venue: position[spec.order.leg].venue, pend };
    });
    runtime.lastClientId = lastClientId;
    const beforePending = position.pending, beforePendingB = position.pendingB ?? null, beforeUpdated = position.updatedAt;
    beforeCommit?.();
    for (const entry of committed) position[entry.slot] = entry.pend;
    position.updatedAt = at;
    try {
      if (store.saveLiveIntent) store.saveLiveIntent(LIVE_RUNTIME_KEY, runtime, position, at);
      else { store.setState(LIVE_RUNTIME_KEY, runtime, at); store.saveLive(position); }
    } catch (error) {
      position.pending = beforePending;
      if (beforePendingB === null) delete position.pendingB;
      else position.pendingB = beforePendingB;
      position.updatedAt = beforeUpdated;
      rollback?.();
      throw new NotSentError(`保存下单意图失败：${message(error)}`);
    }
    for (const entry of committed) {
      if (entry.venue === 'entropy' && deps.onOrderSent) {
        try {
          deps.onOrderSent({ venue: entry.venue, cloid: cloidOf(entry.pend.clientId), positionId: position.id, purpose: entry.pend.purpose, leg: entry.info, assumedFeeBps: deps.takerFeeBps(entry.info), at: entry.pend.sentAt });
        } catch (error) {
          log(`varlighter: 实盘保存 Entropy 订单关联失败：${message(error)}`);
        }
      }
    }
    const settled = await Promise.allSettled(committed.map(async entry => ({
      entry,
      outcome: sane(await deps.trader(entry.venue, keys).place(orderOf(entry.pend, entry.info), deps.signalFor), entry.pend, entry.info),
    })));
    let anyUnknown = false;
    for (const [index, result] of settled.entries()) {
      const entry = committed[index]!;
      if (result.status === 'rejected') {
        anyUnknown = true;
        log(`varlighter: 实盘 ${position.symbol} ${VENUE_NAMES[entry.venue]} 下单异常（按结果未知处理）：${message(result.reason)}`);
        continue;
      }
      const { outcome } = result.value;
      if (outcome.kind === 'unknown') {
        anyUnknown = true;
        log(`varlighter: 实盘 ${position.symbol} ${VENUE_NAMES[entry.venue]} 的单结果未知：${outcome.reason}`);
        continue;
      }
      apply(position, entry.slot, entry.pend, outcome, entry.info, 'sync');
    }
    if (anyUnknown) {
      position.retryAt = now() + 2_000;
      try { save(position); } catch { /* pending 槽位已先落库 */ }
      return false;
    }
    return true;
  }

  /** 发一笔单：先落意图，再发送。返回 false 表示结果未知（pending 留着，下一轮去查）。 */
  async function send(position: LivePosition, info: LegInfo, order: Omit<PendingOrder, 'clientId' | 'sentAt'>, beforeCommit?: () => void, rollback?: () => void): Promise<boolean> {
    return sendBatch(position, [{ slot: 'pending', info, order }], beforeCommit, rollback);
  }
  /** 成交量比委托量还多的回报不可信（单位或字段读错了）：按结果未知处理，交给账户持仓核对。 */
  function sane<T extends ResolveOutcome>(outcome: T, pending: PendingOrder, info: LegInfo): T | { kind: 'unknown'; reason: string } {
    if (outcome.kind === 'done' && !(outcome.filledQty >= 0 && outcome.filledQty <= pending.qty + stepOf(info) / 2)) return { kind: 'unknown', reason: '回报的成交量超过委托量' };
    return outcome;
  }
  const orderOf = (pending: PendingOrder, info: LegInfo): VenueOrder => ({ market: info.market, side: pending.side, qty: pending.qty, limit: pending.limit, reduceOnly: pending.reduceOnly, clientId: pending.clientId });

  /** 记录里（不含这笔在途的单）某场所某代码应有的带符号持仓。 */
  function expected(venue: KeyVenue, symbol: string): number {
    let total = 0;
    for (const position of active.values()) for (const leg of [position.a, position.b]) if (leg.venue === venue && leg.symbol === symbol) total += (leg.side === 'buy' ? 1 : -1) * remainingOf(leg);
    return total;
  }
  const actual = (snapshot: AccountSnapshot, symbol: string) => snapshot.positions.filter(item => item.symbol === symbol).reduce((sum, item) => sum + item.size, 0);

  /** 查一笔结果未知的单；定下来了返回 true。 */
  async function resolvePending(position: LivePosition, slot: 'pending' | 'pendingB', pending: PendingOrder, info: LegInfo): Promise<boolean> {
    const keys = deps.keys.read().keys, leg = position[pending.leg], venue = leg.venue, age = now() - pending.sentAt;
    const queried: ResolveOutcome = sane<ResolveOutcome>(keys[venue] ? await deps.trader(venue, keys).resolve(orderOf(pending, info), pending.sentAt, deps.signalFor) : { kind: 'unknown', reason: '凭据已不在' }, pending, info);
    const queryNote = queried.kind === 'done' ? '' : queried.reason;
    let outcome: OrderOutcome = queried.kind === 'done' ? queried : { kind: 'unknown', reason: queryNote };
    if (outcome.kind === 'unknown' && age >= POSITION_CHECK_MS[venue]) {
      // 查单定不下来，现读一次账户：实际持仓减去记录里应有的，就是这笔单成交的量。
      // - 多出来了、且不超过委托量：IOC 一次撮合就是终态，按多出的量记成交。
      // - 没有变化：这笔单可能还没被执行（Lighter 的交易 10 分钟内都可能被打包），要等它过期之后读到的账户仍没有变化才算没成交；
      //   Entropy 没有过期机制，还要求查单这一次读成功且查无此单。
      // - 其余（反向、超过委托量）：对不上，继续等，到时限交给人。
      try {
        const snapshot = await deps.readAccount(venue, deps.signalFor());
        const delta = (actual(snapshot, leg.symbol) - expected(venue, leg.symbol)) * (pending.side === 'buy' ? 1 : -1), tolerance = stepOf(info) / 2;
        if (delta > tolerance && delta <= pending.qty + tolerance) outcome = { kind: 'done', filledQty: Math.min(pending.qty, delta), avgPrice: null, note: '按账户持仓核对', confirmAt: now() };
        else if (Math.abs(delta) <= tolerance) {
          if (now() - pending.sentAt >= ORDER_EXPIRY_MS[venue] && (venue !== 'entropy' || queried.kind === 'absent')) outcome = { kind: 'done', filledQty: 0, avgPrice: null, note: '订单已过期，账户持仓没有变化', confirmAt: now() };
          else outcome = { kind: 'unknown', reason: `账户持仓暂时没有变化，等订单过期后再确认（${queryNote}）` };
        } else outcome = { kind: 'unknown', reason: '账户持仓与记录对不上' };
      } catch (error) { outcome = { kind: 'unknown', reason: `读账户失败：${message(error)}` }; }
    }
    if (outcome.kind === 'unknown') {
      if (age >= UNKNOWN_STUCK_MS) {
        if (position.state !== 'stuck') stuck(position, `${VENUE_NAMES[venue]} 有一笔单的结果一直定不下来（${outcome.reason}）`);
      } else { position.retryAt = now() + RETRY_MS; }
      return false;
    }
    apply(position, slot, pending, outcome, info, queried.kind === 'done' ? (outcome.confirmSource ?? 'rest') : 'account');
    return true;
  }

  /** 两腿实时可执行价差与预期净利复算：在提交前与发第一腿前拦截已塌缩的假信号。 */
  function liveSpreadProblem(a: LegInfo, b: LegInfo, ratio: number, direction: Direction, strategy: LiveStrategy): string | null {
    const qa = deps.quote(a), qb = deps.quote(b);
    if (!qa || !qb) return `${VENUE_NAMES[!qa ? a.venue : b.venue]} 此刻没有报价`;
    const bMid = ratio * (qb.bid + qb.ask) / 2;
    if (!(bMid > 0 && qa.bid > 0 && qa.ask >= qa.bid && qb.bid > 0 && qb.ask >= qb.bid)) return '此刻行情盘口无效';
    const sellA = (qa.bid - ratio * qb.ask) / bMid * 1e4;
    const buyA = (qa.ask - ratio * qb.bid) / bMid * 1e4;
    const deviation = direction === 'a_rich' ? sellA - strategy.entryBaseline : strategy.entryBaseline - buyA;
    const check = strategy.check;
    if (check) {
      if (deviation < check.entryBps) return `实时价差偏离 ${fmt(deviation, 1)} 基点低于入场阈值 ${fmt(check.entryBps, 1)}`;
      const halfCost = (buyA - sellA) / 2;
      const net = deviation - check.exitBps - halfCost - 4 * check.slippageBps - 2 * (strategy.aFeeBps + strategy.bFeeBps);
      if (net < check.minNetBps) return `实时预期净利 ${fmt(net, 1)} 基点不足 ${fmt(check.minNetBps, 1)}`;
    }
    return null;
  }

  /** 推进一笔持仓，直到要等（结果未知、没有报价、等重试）或到了稳定状态。 */
  async function advance(position: LivePosition): Promise<void> {
    for (let guard = 0; guard < 40; guard++) {
      if (deps.stopped?.() || position.state === 'closed' || position.state === 'stuck' || now() < position.retryAt) return;
      const a = legInfo(position, 'a'), b = legInfo(position, 'b');
      // 目录还没取到（刚启动）时等。
      if (!a || !b) return;
      if (position.state !== 'open' || position.pending || position.pendingB) {
        const keys = deps.keys.read().keys;
        if (!keys[position.a.venue] || !keys[position.b.venue]) {
          // 凭据被移除或文件读不懂：什么都还没发的直接放弃，其余的没法继续，交给人处理。
          if (position.state === 'opening' && position.step === 'a' && !position.pending && !position.pendingB) finish(position, 'not_filled', '凭据已不在，没有下单');
          else stuck(position, '交易凭据已不在，无法继续下单');
          return;
        }
      }
      const pendings = ([['pending', position.pending], ['pendingB', position.pendingB ?? null]] as const)
        .filter((item): item is ['pending' | 'pendingB', PendingOrder] => item[1] !== null);
      if (pendings.length) {
        const resolved = await Promise.all(pendings.map(([slot, pend]) => resolvePending(position, slot, pend, pend.leg === 'a' ? a : b)));
        if (resolved.some(ok => !ok) || position.pending || position.pendingB) return;
        continue;
      }
      if (position.state === 'open') return;
      if (position.state === 'opening') {
        if (position.step === 'a') {
          // 意图落库后没能马上发出（上一轮还在忙、进程重启）：过期、开关已关、配对已不勾选或已停止时作废，不按旧限价补发。
          if (now() - position.openedAt > INTENT_MAX_AGE_MS || !settings.on || !settings.pairs.includes(position.symbol) || runtime.halt) { finish(position, 'not_filled', '开仓意图已过期，没有下单'); return; }
          const stale = quoteProblem(a, position.a.side, position.plan.limit) ?? (position.plan.bLimit === undefined ? null : quoteProblem(b, position.b.side, position.plan.bLimit));
          const spreadReason = stale ?? (position.strategy?.check ? liveSpreadProblem(a, b, position.ratio, position.direction, position.strategy) : null);
          if (spreadReason) { skip(position.symbol, spreadReason); finish(position, 'not_filled', spreadReason); return; }
          // 先把步骤推进到 b，与 pending 同一次落库：之后无论进程在哪里退出，重启后都只会去查这笔单，不会再发第一腿（L039、L095）。
          const signalAt = position.strategy?.signalBbo?.at ?? position.openedAt;
          const sentA = await send(
            position,
            a,
            { leg: 'a', purpose: 'open', side: position.a.side, qty: position.plan.qty, limit: position.plan.limit, expectedPrice: position.plan.expected ?? position.plan.limit, signalAt, reduceOnly: false },
            () => { position.step = 'b'; },
            () => { position.step = 'a'; },
          );
          if (!sentA) return;
          continue;
        }
        if (position.a.qty <= 0) { finish(position, 'not_filled', `${VENUE_NAMES[position.a.venue]} ${FIRST_LEG_MISSED_NOTE}，放弃`); return; }
        if (position.step === 'b') {
          const target = floorTo(position.a.qty * position.ratio, b.market.sizeDecimals ?? 0), quote = deps.quote(b);
          if (target >= Math.max(stepOf(b), b.market.minBase) && quote) {
            const side = position.b.side, expectedPrice = side === 'buy' ? quote.ask : quote.bid;
            const [limit] = limitPrice(b, side, expectedPrice, settings.limits.slippageBps);
            const openAConfirmAt = position.orders?.find(item => item.role === 'openA')?.confirmAt ?? now();
            let sentB: boolean;
            try {
              sentB = await send(
                position,
                b,
                { leg: 'b', purpose: 'hedge', side, qty: target, limit, expectedPrice, signalAt: openAConfirmAt, reduceOnly: false },
                () => { position.step = 'settle'; },
                () => { position.step = 'b'; },
              );
            } catch (error) {
              if (error instanceof NotSentError) hedgeBlocked(position, error);
              throw error;
            }
            hedgeFailSince.delete(position.id);
            if (!sentB) { save(position); return; }
          } else {
            position.step = 'settle';
            save(position);
          }
          continue;
        }
        // settle：A 比 B 多出来的部分在 A 上反向平掉。两腿步长不同、乘数除不尽时总会差一点：不到 B 一个步长的等值的余量不算单腿、不回补，
        // 留到平仓时两腿各自平掉。比这多的都是真实的单腿敞口，哪怕低于最小下单量也照常回补（只减仓单交易所不收时重试到上限转人工并告警）。
        // 取整余量只可能出现在 B 已补齐目标时；B 少成交哪怕一个步长，都是真实敞口。
        const excess = floorTo(remainingOf(position.a) - position.b.qty / position.ratio, a.market.sizeDecimals ?? 0);
        const dust = position.b.qty > 0 && position.b.qty >= floorTo(position.a.qty * position.ratio, b.market.sizeDecimals ?? 0) - stepOf(b) / 2;
        if (excess >= stepOf(a) && !dust) {
          position.singleLeg = true;
          if (position.tries >= MAX_FLATTEN_TRIES) { stuck(position, `${VENUE_NAMES[position.a.venue]} 多出的 ${excess} 平不掉（第二腿没有补齐）`); return; }
          const quote = deps.quote(a);
          if (!quote) { waitQuote(position, position.a.venue); return; }
          position.waitSince = null;
          const side = opposite(position.a.side), expectedPrice = side === 'buy' ? quote.ask : quote.bid;
          const [limit] = limitPrice(a, side, expectedPrice, Math.min(300, Math.max(100, settings.limits.slippageBps * 3) * (position.tries + 1)));
          const before = position.a.exitQty, beforeTries = position.tries;
          const signalAt = position.orders?.find(item => item.role === 'openB')?.confirmAt ?? position.updatedAt;
          if (!await send(position, a, { leg: 'a', purpose: 'flatten', side, qty: excess, limit, expectedPrice, signalAt, reduceOnly: true }, () => { position.tries++; }, () => { position.tries = beforeTries; })) return;
          if (position.a.exitQty === before) position.retryAt = now() + RETRY_MS;
          continue;
        }
        if (position.b.qty <= 0) { finish(position, 'single_leg', `${VENUE_NAMES[position.b.venue]} 第二腿没有成交，第一腿已平掉`); return; }
        position.state = 'open'; position.tries = 0; position.waitSince = null;
        save(position);
        event(position.symbol, `实盘开仓：${VENUE_NAMES[position.a.venue]} ${position.a.side === 'buy' ? '买' : '卖'} ${fmt(remainingOf(position.a), 6)}，${VENUE_NAMES[position.b.venue]} ${position.b.side === 'buy' ? '买' : '卖'} ${fmt(position.b.qty, 6)}${position.singleLeg ? '（第二腿只成交了一部分，多出的已平掉）' : ''}`);
        return;
      }
      // closing：两腿各自只减仓并发平掉（L039：先在单次事务落好两腿待发意图再并发下发）。
      const remLegs = ([['a', a], ['b', b]] as const).filter(([name, info]) => remainingOf(position[name]) >= stepOf(info) - 1e-12);
      if (!remLegs.length) { finish(position, position.closeReason ?? 'signal', ''); return; }
      if (position.tries >= MAX_CLOSE_TRIES) {
        const [firstName, firstInfo] = remLegs[0]!;
        stuck(position, `${VENUE_NAMES[firstInfo.venue]} 剩余 ${fmt(remainingOf(position[firstName]), 6)} 平不掉`);
        return;
      }
      const quotes = new Map<LegName, { bid: number; ask: number }>();
      for (const [name, info] of remLegs) {
        const quote = deps.quote(info);
        if (!quote) { waitQuote(position, position[name].venue); return; }
        quotes.set(name, quote);
      }
      position.waitSince = null;
      const slippage = Math.min(300, Math.max(50, settings.limits.slippageBps) * (1 + Math.floor(position.tries / 2)));
      const signalAt = position.closeSignalAt ?? now();
      const specs: SendSpec[] = remLegs.map(([name, info], index) => {
        const leg = position[name], quote = quotes.get(name)!, side = opposite(leg.side);
        const expectedPrice = side === 'buy' ? quote.ask : quote.bid;
        const [limit] = limitPrice(info, side, expectedPrice, slippage);
        return {
          slot: index === 0 ? 'pending' : 'pendingB',
          info,
          order: { leg: name, purpose: 'close', side, qty: floorTo(remainingOf(leg), info.market.sizeDecimals ?? 0), limit, expectedPrice, signalAt, reduceOnly: true },
        };
      });
      const beforeExitA = position.a.exitQty, beforeExitB = position.b.exitQty, beforeTries = position.tries;
      if (!await sendBatch(position, specs, () => { position.tries++; }, () => { position.tries = beforeTries; })) return;
      const stalledLeg = specs.some(spec => {
        const legName = spec.order.leg;
        const prev = legName === 'a' ? beforeExitA : beforeExitB;
        return remainingOf(position[legName]) >= stepOf(spec.info) - 1e-12 && position[legName].exitQty === prev;
      });
      if (stalledLeg) { position.retryAt = now() + RETRY_MS; save(position); }
    }
  }

  /** 定时对账：没有动作在途时，记录里应有的持仓与账户实际持仓逐个比；连续两次对不上就停止。 */
  function reconcile(): void {
    const time = now();
    if (time < nextReconcile) return;
    nextReconcile = time + RECONCILE_MS;
    const positions = [...active.values()];
    if (positions.some(position => position.state === 'opening' || position.state === 'closing' || position.pending || position.pendingB)) { mismatchStreak = 0; return; }
    // 要核对的合约：实盘持仓的两腿；总开关开着时还有勾选配对的两腿（没有持仓时应当是零仓，账户是专用的）。
    const checks = new Map<string, { venue: KeyVenue; symbol: string; step: number }>();
    for (const position of positions) for (const name of ['a', 'b'] as const) {
      const leg = position[name], info = legInfo(position, name);
      if (info) checks.set(`${leg.venue}:${leg.symbol}`, { venue: leg.venue, symbol: leg.symbol, step: stepOf(info) });
    }
    if (settings.on && !runtime.halt) for (const key of settings.pairs) {
      const pair = deps.pairOf(key);
      if (pair) for (const info of [pair.a, pair.b]) if (isKeyVenue(info.venue)) { const symbol = positionSymbol(info); if (!checks.has(`${info.venue}:${symbol}`)) checks.set(`${info.venue}:${symbol}`, { venue: info.venue, symbol, step: stepOf(info) }); }
    }
    if (!checks.size) { mismatchStreak = 0; blindSince = null; return; }
    const problems: string[] = [];
    for (const check of checks.values()) {
      const read = deps.account(check.venue);
      // 没录凭据的场所不核对。
      if (!read && !deps.keys.read().keys[check.venue]) continue;
      // 只用动作结束之后、三分钟以内读到的账户；读数一直不够新而手里有持仓，本身要告警。
      if (!read || time - read.at > ACCOUNT_FRESH_MS) {
        blindSince ??= time;
        if (positions.length && time - blindSince >= ACCOUNT_BLIND_ALERT_MS) alert(`blind:${Math.floor(blindSince / 60_000)}`, `【DEX 价差实盘】${VENUE_NAMES[check.venue]} 的账户已超过 ${Math.round((time - blindSince) / 60_000)} 分钟读不到，有实盘持仓无法对账；请核对交易所账户`);
        return;
      }
      if (read.at < lastOperationAt + RECONCILE_SETTLE_MS) return;
      const want = expected(check.venue, check.symbol), have = actual(read.snapshot, check.symbol);
      if (Math.abs(want - have) > check.step / 2) problems.push(`${VENUE_NAMES[check.venue]} ${check.symbol} 记录 ${fmt(want, 6)}、账户 ${fmt(have, 6)}`);
    }
    blindSince = null;
    if (!problems.length) { mismatchStreak = 0; return; }
    if (++mismatchStreak >= 2) halt(`账户持仓与实盘记录对不上：${[...new Set(problems)].join('；')}`);
  }

  /** 定时账户读数尚未反映到的已占用保证金（仍在开仓中或该场所开仓腿确认晚于/不早于读数时刻，按开仓时倍率折算）。 */
  function committedSinceRead(venue: KeyVenue, readAt: number): number {
    let used = 0;
    for (const position of active.values()) {
      if (position.a.venue !== venue && position.b.venue !== venue) continue;
      const leg = position.a.venue === venue ? position.a : position.b;
      if (position.state !== 'opening' && leg.qty <= 0) continue;
      const openOrder = position.orders?.find(item => item.venue === venue && (item.role === 'openA' || item.role === 'openB'));
      const reflectedByRead = openOrder ? openOrder.confirmAt < readAt : position.state !== 'opening' && position.openedAt < readAt;
      if (reflectedByRead) continue;
      const usd = position.strategy?.notionalUsd ?? position.plan.qty * position.plan.limit;
      const lev = position.strategy?.maxLeverage ?? 1;
      if (Number.isFinite(usd) && usd > 0) used += usd / lev;
    }
    return used;
  }

  /**
   * 开仓前检查并计算可用余额与倍率上限允许的有效名义金额（>1x 时强制保留 5% 缓冲）。
   * memo 只给只读的页面读数用：一次读数里各配对共用凭据文件、签名器检查与当日已实现的读数；下单路径不传，每次现读。
   */
  function checkOpen(pair: PairInfo, requestedUsd: number, memo?: BlockerMemo): LiveBlock | { notionalUsd: number } {
    const wait = (reason: string): LiveBlock => ({ reason, attention: false }), act = (reason: string): LiveBlock => ({ reason, attention: true });
    if (!settings.on) return wait('实盘总开关未开');
    if (!settings.pairs.includes(pair.key)) return wait('这个配对没有开实盘');
    if (runtime.halt) return act(`实盘已停止：${runtime.halt}`);
    if (runtime.paused[pair.key]) return act(`这个配对的实盘已暂停：${runtime.paused[pair.key]}`);
    if (!isKeyVenue(pair.a.venue) || !isKeyVenue(pair.b.venue)) return wait('带 Var 腿的配对不上实盘');
    const { keys, problem } = memo ? memo.keys ??= deps.keys.read() : deps.keys.read();
    if (problem) return act(problem);
    const lev = execSettings.maxLeverage, marginReserve = lev > 1 ? 0.95 : 1;
    let tightVenue: KeyVenue = pair.a.venue, tightAvail = Infinity, tightCap = Infinity;
    for (const venue of [pair.a.venue, pair.b.venue]) {
      if (!keys[venue]) return act(`${VENUE_NAMES[venue]} 还没有录入凭据`);
      let missing = memo?.venues.get(venue);
      if (missing === undefined) { missing = deps.venueProblem(venue); memo?.venues.set(venue, missing); }
      if (missing) return act(missing);
      const read = deps.account(venue);
      if (!read || now() - read.at > ACCOUNT_FRESH_MS) return act(`${VENUE_NAMES[venue]} 账户读数不够新`);
      const effectiveAvail = Math.max(0, read.snapshot.available - committedSinceRead(venue, read.at));
      const venueCap = effectiveAvail * lev * marginReserve;
      if (!execSettings.autoSizeByBalance && venueCap < requestedUsd) {
        return act(lev > 1
          ? `${VENUE_NAMES[venue]} 可用余额 ${fmt(effectiveAvail, 2)}（按 ${lev}× 预留 5% 缓冲上限 ${fmt(venueCap, 2)}）不足单笔金额 ${fmt(requestedUsd, 0)}`
          : `${VENUE_NAMES[venue]} 可用余额 ${fmt(effectiveAvail, 2)} 不足单笔金额 ${fmt(requestedUsd, 0)}`);
      }
      if (venueCap < tightCap) {
        tightCap = venueCap;
        tightAvail = effectiveAvail;
        tightVenue = venue;
      }
    }
    let notionalUsd = requestedUsd;
    if (execSettings.autoSizeByBalance && tightCap < requestedUsd) {
      const scaled = Math.floor(lev > 1 ? tightCap : tightAvail * 0.95);
      const minFloor = Math.max(10, pair.a.market.minQuote, pair.b.market.minQuote);
      if (scaled < minFloor) {
        return act(lev > 1
          ? `${VENUE_NAMES[tightVenue]} 可用余额 ${fmt(tightAvail, 2)}（按 ${lev}× 预留 5% 缓冲上限 ${fmt(tightCap, 2)}）不足最小金额 ${fmt(minFloor, 0)}`
          : `${VENUE_NAMES[tightVenue]} 可用余额 ${fmt(tightAvail, 2)} 不足最小金额 ${fmt(minFloor, 0)}`);
      }
      notionalUsd = scaled;
    }
    const open = [...active.values()];
    if (open.some(position => position.symbol === pair.key)) return wait('这个配对已有实盘持仓');
    const legs = new Set([`${pair.a.venue}:${positionSymbol(pair.a)}`, `${pair.b.venue}:${positionSymbol(pair.b)}`]);
    if (open.some(position => legs.has(`${position.a.venue}:${position.a.symbol}`) || legs.has(`${position.b.venue}:${position.b.symbol}`))) return wait('有一条腿已被别的实盘持仓占用');
    if (open.length >= settings.limits.maxOpen) return wait(`实盘持仓已到上限 ${settings.limits.maxOpen} 笔`);
    const today = dayStart(now());
    if (memo && memo.todayNet?.day !== today) memo.todayNet = { day: today, value: store.liveNetSince(today) };
    const todayNet = memo ? memo.todayNet!.value : store.liveNetSince(today);
    if (todayNet <= -settings.limits.dailyLossUsd) return act(`当日已实现亏损达到上限 ${fmt(settings.limits.dailyLossUsd, 0)} 美元`);
    return { notionalUsd };
  }
  function resolveBlocker(pair: PairInfo, requestedUsd: number): string | { notionalUsd: number } {
    const checked = checkOpen(pair, requestedUsd);
    return 'reason' in checked ? checked.reason : checked;
  }

  async function drive(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      for (const position of [...active.values()]) {
        if (deps.stopped?.()) return;
        try { await advance(position); } catch (error) { position.retryAt = now() + RETRY_MS; log(`varlighter: 实盘 ${position.symbol} 推进失败：${message(error)}`); }
      }
      try { reconcile(); } catch (error) { log(`varlighter: 实盘对账失败：${message(error)}`); }
    } finally { busy = false; }
  }
  const kick = () => { void drive().catch(error => log(`varlighter: 实盘推进失败：${message(error)}`)); };

  function requestClose(position: LivePosition, reason: string, signalAt = now()): void {
    if (position.state === 'open') { position.state = 'closing'; position.closeReason = reason; position.closeSignalAt = signalAt; position.tries = 0; position.retryAt = 0; save(position); }
    // 还在开仓的不动：开仓走完变成持有中后，引擎下一次判断会再给出平仓信号。
  }
  function flushSkipStats(): void {
    if (!skipDirty) return;
    skipDirty = false; skipSavedAt = now();
    try { (store.saveLiveState ?? store.setState)(LIVE_SKIP_STATS_KEY, skipStats, skipSavedAt); } catch (error) { log(`varlighter: 实盘跳过统计写入失败：${message(error)}`); }
  }
  function skip(key: string, reason: string): string {
    const time = now(), today = dayStart(time);
    lastSkip = { at: time, symbol: key, reason };
    if (skipStats.day !== today) skipStats = { day: today, total: 0, byReason: {} };
    const bucket = Object.keys(skipStats.byReason).length >= 32 && !(skipBucket(reason) in skipStats.byReason) ? '其他原因' : skipBucket(reason);
    skipStats.total++;
    skipStats.byReason[bucket] = (skipStats.byReason[bucket] ?? 0) + 1;
    // 行情流推送判断下，同一个原因一秒里可能被挡很多次：统计每次都记，落库（一次同步刷盘）最多一秒一次，余下的由下一次推进补上。
    skipDirty = true;
    if (Math.abs(time - skipSavedAt) >= SKIP_SAVE_MS) flushSkipStats();
    const id = `${key}\n${reason}`;
    if (time - (skipEventAt.get(id) ?? -Infinity) >= SKIP_EVENT_MS) {
      skipEventAt.set(id, time);
      if (skipEventAt.size > 200) skipEventAt.delete(skipEventAt.keys().next().value!);
      event(key, `实盘没有开仓：${reason}`);
    }
    return reason;
  }

  /** 最近 50 笔已结束的持仓，以及其中排不下的更早的有成交持仓（两者里有成交的合起来是最近 50 笔有成交的）。 */
  function closedLists(): { trades: LivePosition[]; tradedMore?: LivePosition[] } {
    if (!closedCache) {
      const trades = store.liveClosed(LIVE_TRADES_SHOWN), listed = new Set(trades.map(position => position.id));
      closedCache = { trades, tradedMore: store.liveTradedClosed?.(LIVE_TRADES_SHOWN).filter(position => !listed.has(position.id)) };
    }
    return { trades: closedCache.trades, ...(closedCache.tradedMore && { tradedMore: closedCache.tradedMore }) };
  }

  return {
    /**
     * 策略给出开仓信号：实盘检查（总开关、勾选、凭据、余额按 95% 缩量、限额、预演、两腿此刻的报价与实时价差）都通过时返回提交开仓的函数，否则返回不开的原因。
     * 检查与提交分开：引擎先把这一刻的样本落盘，再提交。
     */
    prepare(pair: PairInfo, signal: LiveSignal, sample: Sample): string | (() => void) {
      const requestedUsd = Math.min(signal.notionalUsd, settings.limits.perTradeUsd);
      const checked = resolveBlocker(pair, requestedUsd);
      let reason = typeof checked === 'string' ? checked : null;
      const notionalUsd = typeof checked === 'string' ? requestedUsd : checked.notionalUsd;
      const plan = reason ? null : orderPlan(pair, sample, signal.direction, notionalUsd, execSettings.openLegASlippageBps, now(), settings.limits.slippageBps);
      if (plan && !plan.ready) reason = plan.checks.find(check => !check.ok)?.label ?? '下单预演没有通过';
      // 样本可能有一腿是旧的：两腿此刻的可成交价都不能比预演的限价差，且实时双腿价差仍满足开仓门槛（L100）。
      if (plan && !reason) {
        reason = quoteProblem(pair.a, plan.legs[0].side, Number(plan.legs[0].limit))
          ?? quoteProblem(pair.b, plan.legs[1].side, Number(plan.legs[1].limit))
          ?? (signal.check ? liveSpreadProblem(pair.a, pair.b, pair.ratio, signal.direction, { ...signal.strategy, notionalUsd, check: signal.check }) : null);
      }
      if (reason || !plan) return skip(pair.key, reason ?? '下单预演没有通过');
      return () => {
        const [legA, legB] = plan.legs, time = now();
        // 提交前再看一次：两次调用之间别处可能已在这个配对或这条腿上开了仓。
        const late = resolveBlocker(pair, requestedUsd);
        if (typeof late === 'string') { skip(pair.key, late); return; }
        if (late.notionalUsd < notionalUsd) { skip(pair.key, '可用余额变化，放弃本次机会'); return; }
        const leg = (info: LegInfo, side: Side): LiveLeg => ({ venue: info.venue as KeyVenue, symbol: positionSymbol(info), side, qty: 0, entryQuote: 0, exitQty: 0, exitQuote: 0, feesUsd: 0, estimated: false, market: info.market, code: info.symbol });
        const id = `l${time.toString(36)}-${(++sequence).toString(36)}`;
        const position: LivePosition = {
          // paperId 取自己的编号：本版本不读它；回滚到 v0.111.2 时旧版本找不到这个编号的模拟持仓，会立即只减仓平掉（docs/dexspread.md 18.3）。
          id, paperId: id, symbol: pair.key, direction: signal.direction, ratio: pair.ratio, state: 'opening', step: 'a',
          openedAt: time, updatedAt: time, closedAt: null, a: leg(pair.a, legA.side), b: leg(pair.b, legB.side),
          plan: { qty: Number(legA.qty), limit: Number(legA.limit), bLimit: Number(legB.limit), expected: legA.expected },
          pending: null, tries: 0, retryAt: 0, closeReason: null, singleLeg: false, netUsd: null, note: '',
          strategy: { ...signal.strategy, notionalUsd, ...(execSettings.maxLeverage > 1 && { maxLeverage: execSettings.maxLeverage }), ...(signal.check && { check: signal.check }) },
        };
        store.saveLive(position);
        active.set(position.id, position);
        event(pair.key, `实盘开仓信号：${signal.direction === 'a_rich' ? '卖 A 买 B' : '买 A 卖 B'}，名义 ${fmt(notionalUsd, 0)} 美元，信号价差 ${fmt(signal.strategy.entrySpread, 1)} 基点，基线 ${fmt(signal.strategy.entryBaseline, 1)}`);
        kick();
      };
    },
    /** 策略给出平仓信号：这个配对持有中的实盘持仓两腿并发只减仓平掉。 */
    signalClose(key: string, reason: string, signalAt = now()): void {
      for (const position of active.values()) if (position.symbol === key) requestClose(position, reason, signalAt);
      kick();
    },
    /** 未结束的实盘持仓（开仓中、持有中、平仓中、需要人工处理）。 */
    active: (): LivePosition[] => [...active.values()],
    /** 每秒调用一次：推进在途的持仓、对账。 */
    tick(): void { flushSkipStats(); kick(); },
    /** 等当前这一轮推进结束（测试用）。 */
    async idle(): Promise<void> { while (busy) await new Promise(resolve => setImmediate(resolve)); flushSkipStats(); },
    /**
     * 现在给这个配对一个开仓信号，实盘检查（总开关、勾选、停止与暂停、凭据、账户读数与余额、持仓占用与上限、当日亏损）会不会挡下：返回原因，不挡为 null。
     * 只读、不计入被挡统计；下单预演与两腿此刻的实时价差要等真有信号才看。
     */
    blocker(pair: PairInfo, notionalUsd: number, memo?: BlockerMemo): LiveBlock | null {
      const checked = checkOpen(pair, Math.min(notionalUsd, settings.limits.perTradeUsd), memo);
      return 'reason' in checked ? checked : null;
    },
    drive,
    alerts: (): LiveAlert[] => [...alerts],
    settings: () => settings,
    exec: () => execSettings,
    /** 改实盘设置：`on`、`pairs`、`limits` 与执行优化参数 `exec` 分键落库；旧键保持原字段集合。 */
    update(body: unknown, known: (key: string) => boolean): LiveSettings {
      if (!isObject(body)) throw new LiveError('invalid_params', '实盘设置格式无效');
      const { exec: execRaw, ...rest } = body;
      const hasBase = Object.keys(rest).length > 0;
      const next = hasBase
        ? readLiveSettings({ on: settings.on, pairs: settings.pairs, limits: settings.limits, ...rest }, key => known(key) || (!('pairs' in rest) && settings.pairs.includes(key)))
        : settings;
      const nextExec = 'exec' in body ? readLiveExecSettings(execRaw, execSettings) : execSettings;
      const time = now();
      if (hasBase) (store.saveLiveState ?? store.setState)(LIVE_SETTINGS_KEY, next, time);
      if ('exec' in body) (store.saveLiveState ?? store.setState)(LIVE_EXEC_KEY, nextExec, time);
      const turnedOn = next.on && !settings.on;
      settings = next;
      execSettings = nextExec;
      if (hasBase) event(null, `实盘设置已更新：总开关${next.on ? '开' : '关'}，配对 ${next.pairs.length} 个，单笔 ${fmt(next.limits.perTradeUsd, 0)} 美元、最多 ${next.limits.maxOpen} 笔、当日亏损上限 ${fmt(next.limits.dailyLossUsd, 0)} 美元`);
      if ('exec' in body) event(null, `实盘执行优化已更新：A 腿滑点 ${nextExec.openLegASlippageBps} bps、信号确认 ${nextExec.confirmMs} ms、未成冷却 ${nextExec.notFilledCooldownSec} s、倍率上限 ${nextExec.maxLeverage}×、余额缩量${nextExec.autoSizeByBalance ? '开' : '关'}`);
      if (turnedOn) log('varlighter: 实盘总开关已打开');
      return settings;
    },
    /** 手动平一笔实盘持仓。 */
    close(body: unknown): { ok: true } {
      const position = isObject(body) && typeof body.id === 'string' ? active.get(body.id) : undefined;
      if (!position) throw new LiveError('not_found', '没有这笔实盘持仓', 404);
      if (position.state !== 'open') throw new LiveError('busy', position.state === 'stuck' ? '这笔持仓需要人工处理' : '这笔持仓正在开仓或平仓中', 409);
      requestClose(position, 'manual', now());
      kick();
      return { ok: true };
    },
    /** 人工在交易所处理完一笔卡住的持仓后，把它标记为已结束（不发任何单）。 */
    dismiss(body: unknown): { ok: true } {
      const position = isObject(body) && typeof body.id === 'string' && body.confirm === 'DISMISS' ? active.get(body.id) : undefined;
      if (!position) throw new LiveError('not_found', '没有这笔实盘持仓（需要确认文字 DISMISS）', 404);
      if (position.state !== 'stuck') throw new LiveError('busy', '只有需要人工处理的持仓才能这样结束', 409);
      finish(position, 'dismissed', '已人工处理，按记录到的成交结算');
      return { ok: true };
    },
    /** 清除停止与配对暂停。有卡住的持仓时不能恢复。 */
    resume(): { ok: true } {
      if ([...active.values()].some(position => position.state === 'stuck')) throw new LiveError('busy', '还有需要人工处理的实盘持仓，先处理并结束它', 409);
      runtime.halt = null; runtime.paused = {}; runtime.singles = {}; mismatchStreak = 0; nextReconcile = now() + RECONCILE_MS; lastOperationAt = now();
      saveRuntime();
      event(null, '实盘已恢复');
      return { ok: true };
    },
    /** 某场所的凭据能否移除：还有持仓用着就不能。 */
    venueInUse: (venue: KeyVenue) => [...active.values()].some(position => position.a.venue === venue || position.b.venue === venue),
    view() {
      const time = now(), today = dayStart(time);
      if (skipStats.day !== today) skipStats = { day: today, total: 0, byReason: {} };
      return {
        now: time, settings, exec: execSettings, halt: runtime.halt, paused: runtime.paused, lastSkip, skipStats,
        privateStreams: deps.privateStreams?.() ?? {},
        positions: [...active.values()].sort((x, y) => x.openedAt - y.openedAt),
        ...closedLists(), todayNetUsd: store.liveNetSince(today), totals: summary?.totals() ?? store.liveTotals(),
        ...(summary && { outcomes: summary.outcomes(time), breakdown: summary.breakdown(time) }),
      };
    },
  };
}
export type LiveTrader = ReturnType<typeof createLiveTrader>;

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
