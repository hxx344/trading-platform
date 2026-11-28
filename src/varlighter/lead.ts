// DEX 价差子模块「Binance 领先测速」纯算法、目录匹配与参数校验：
// 使用同机单调时钟（monoMs）计算 Binance 永续合约相对 Lighter 主网 / Lighter RH / Entropy 的领先延迟，
// 提供「同门槛跃动跟随统计」与「100ms 网格 500ms 重叠收益率互相关」两套口径。无网络 I/O 与存储依赖。
import { LEG_SYMBOL, SYMBOL_ALIASES, type MarketSpec } from './model.ts';
import { ParamsError } from './strategy.ts';
import type {
  LeadCandidateView,
  LeadConfig,
  LeadContractView,
  LeadEventVenueView,
  LeadEventView,
  LeadFollowStatus,
  LeadSeriesPoint,
  LeadSessionView,
  LeadSource,
  LeadStreamView,
  LeadVenue,
  LeadVenueStatsView,
  LeadXcorrPoint,
  LeadXcorrView,
} from './views.ts';

export const LEAD_VENUES: readonly LeadVenue[] = ['lighter', 'rh', 'entropy'];
export const LEAD_VENUE_NAMES: Record<LeadVenue, string> = { lighter: 'Lighter 主网', rh: 'Lighter RH', entropy: 'Entropy' };
export const LEAD_SOURCES: readonly LeadSource[] = ['binance', ...LEAD_VENUES];
export const LEAD_SOURCE_NAMES: Record<LeadSource, string> = { binance: 'Binance 永续', ...LEAD_VENUE_NAMES };

export const DEFAULT_LEAD_CONFIG: Omit<LeadConfig, 'binanceSymbol' | 'targets'> = {
  durationSec: 180,
  thresholdBps: 3,
  impulseWindowMs: 1_000,
  followRatio: 0.5,
  maxWaitMs: 10_000,
  cooldownMs: 2_000,
};

export const LEAD_LIMITS = {
  durationSec: [30, 1800] as const,
  thresholdBps: [0.5, 500] as const,
  impulseWindowMs: [100, 10_000] as const,
  followRatio: [0.2, 1.0] as const,
  maxWaitMs: [1_000, 30_000] as const,
  cooldownMs: [500, 30_000] as const,
};

export const LEAD_GRID_STEP_MS = 100;
export const LEAD_RETURN_HORIZON_STEPS = 5; // 500 ms
export const LEAD_XCORR_MIN_LAG_MS = -1_000;
export const LEAD_XCORR_MAX_LAG_MS = 3_000;
export const LEAD_XCORR_MIN_SAMPLES = 50;
export const LEAD_PRE_WINDOW_MS = 1_500;
export const LEAD_BASE_STALE_MS = 60_000;
export const LEAD_BASIS_MAX_GAP_PCT = 0.05;
export const LEAD_SERIES_WINDOW_MS = 60_000;
export const LEAD_SERIES_STRIDE = 2; // 2 * 100ms = 200 ms
export const LEAD_MAX_EVENTS_VIEW = 100;
export const LEAD_HISTORY_MAX = 20;
const MAX_GRID_CELLS = 18_050; // 30 分钟上限（1800s / 0.1s）留余量
const MAX_TICKS_PER_STREAM = 8_000;
const MAX_LAGS_PER_VENUE = 4_000;

export type BinanceContract = LeadContractView;

export interface QuoteTick {
  monoMs: number;
  wallMs: number;
  bid: number;
  ask: number;
  mid: number;
  exchangeMs: number | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class LeadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (message: string): never => {
  throw new ParamsError(message);
};

function readNumber(value: unknown, min: number, max: number, name: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${name}须为 ${min} 到 ${max} 之间的${integer ? '整数' : '数'}`);
  }
  return value as number;
}

const BINANCE_SYMBOL_RE = /^[A-Z0-9]{2,32}$/;
const STABLE_QUOTES = new Set(['USDT', 'USDC']);

/** 校验并规整测速启动参数。 */
export function readLeadConfig(raw: unknown): LeadConfig {
  if (!isObject(raw)) return fail('测速参数须为对象');
  const allowed = ['binanceSymbol', 'targets', 'durationSec', 'thresholdBps', 'impulseWindowMs', 'followRatio', 'maxWaitMs', 'cooldownMs'];
  const unknown = Object.keys(raw).find(key => !allowed.includes(key));
  if (unknown) return fail(`测速参数包含未知字段 ${unknown.slice(0, 40)}`);

  const symRaw = typeof raw.binanceSymbol === 'string' ? raw.binanceSymbol.trim().toUpperCase() : '';
  if (!BINANCE_SYMBOL_RE.test(symRaw)) return fail('Binance 合约代码无效（应为 2–32 位大写字母或数字，如 BTCUSDT）');

  if (!isObject(raw.targets)) return fail('目标场所映射无效');
  const unknownVenue = Object.keys(raw.targets).find(key => !(LEAD_VENUES as readonly string[]).includes(key));
  if (unknownVenue) return fail(`包含不支持的对比场所 ${unknownVenue.slice(0, 24)}`);

  const targets: Partial<Record<LeadVenue, string>> = {};
  for (const venue of LEAD_VENUES) {
    const val = raw.targets[venue];
    if (val === undefined || val === null) continue;
    if (typeof val !== 'string') return fail(`${LEAD_VENUE_NAMES[venue]} 代码须为文本`);
    const trimmed = val.trim();
    if (!trimmed) continue;
    if (!LEG_SYMBOL.test(trimmed)) return fail(`${LEAD_VENUE_NAMES[venue]} 代码无效`);
    targets[venue] = trimmed;
  }
  if (!Object.keys(targets).length) return fail('至少选择一个需要对比的 DEX 场所并填写标的代码');

  const pick = <K extends keyof typeof DEFAULT_LEAD_CONFIG>(key: K) =>
    raw[key] === undefined ? DEFAULT_LEAD_CONFIG[key] : raw[key];

  return {
    binanceSymbol: symRaw,
    targets,
    durationSec: readNumber(pick('durationSec'), ...LEAD_LIMITS.durationSec, '测试时长（秒）', true),
    thresholdBps: readNumber(pick('thresholdBps'), ...LEAD_LIMITS.thresholdBps, '触发阈值（基点）', false),
    impulseWindowMs: readNumber(pick('impulseWindowMs'), ...LEAD_LIMITS.impulseWindowMs, '变化窗口（毫秒）', true),
    followRatio: readNumber(pick('followRatio'), ...LEAD_LIMITS.followRatio, '跟进判定比例', false),
    maxWaitMs: readNumber(pick('maxWaitMs'), ...LEAD_LIMITS.maxWaitMs, '最大等待时间（毫秒）', true),
    cooldownMs: readNumber(pick('cooldownMs'), ...LEAD_LIMITS.cooldownMs, '事件冷却时间（毫秒）', true),
  };
}

/** 解析 Binance `GET /fapi/v1/exchangeInfo` 返回的活跃 U 本位永续合约（含 TradFi 永续）。 */
export function parseBinanceExchangeInfo(raw: unknown): BinanceContract[] {
  if (!isObject(raw) || !Array.isArray(raw.symbols)) throw new Error('Binance 合约目录格式无效');
  const seen = new Map<string, BinanceContract>();
  for (const item of raw.symbols) {
    if (!isObject(item)) continue;
    if (item.status !== 'TRADING') continue;
    if (item.contractType !== 'PERPETUAL' && item.contractType !== 'TRADIFI_PERPETUAL') continue;
    const quoteAsset = typeof item.quoteAsset === 'string' ? item.quoteAsset : '';
    const marginAsset = typeof item.marginAsset === 'string' ? item.marginAsset : '';
    if (!STABLE_QUOTES.has(quoteAsset) || marginAsset !== quoteAsset) continue;
    const symbol = typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '';
    const baseAsset = typeof item.baseAsset === 'string' ? item.baseAsset.trim().toUpperCase() : '';
    if (!BINANCE_SYMBOL_RE.test(symbol) || !baseAsset || !LEG_SYMBOL.test(baseAsset)) continue;
    seen.set(symbol, {
      symbol,
      baseAsset,
      quoteAsset,
      contractType: item.contractType,
    });
  }
  return [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const LEAD_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ...SYMBOL_ALIASES,
  ['ANT', 'ANTHROPIC', 'ANTH'],
  ['OPENAI', 'OAI'],
];

function aliasCandidates(base: string): string[] {
  const candidates = [base];
  for (const group of LEAD_ALIAS_GROUPS) {
    if (group.includes(base)) {
      for (const alias of group) if (!candidates.includes(alias)) candidates.push(alias);
    }
  }
  return candidates;
}

/** 按优先级将单个 Binance 永续合约自动匹配到 Lighter 主网 / Lighter RH / Entropy 标的代码。 */
export function matchDexTargets(
  contract: BinanceContract,
  dexMarkets: Record<LeadVenue, readonly MarketSpec[]>,
): Partial<Record<LeadVenue, string>> {
  const base = contract.baseAsset.toUpperCase();
  const aliases = aliasCandidates(base).filter(item => item !== base);
  const scaleVariants: string[] = [];
  if (base.startsWith('1000') && base.length > 4) scaleVariants.push(base.slice(4));
  else scaleVariants.push(`1000${base}`);

  const targets: Partial<Record<LeadVenue, string>> = {};
  for (const venue of LEAD_VENUES) {
    const markets = dexMarkets[venue] ?? [];
    const byUpper = new Map<string, string>();
    for (const m of markets) {
      const upper = m.symbol.toUpperCase();
      if (!byUpper.has(upper)) byUpper.set(upper, m.symbol);
    }
    const exact = byUpper.get(base);
    if (exact) {
      targets[venue] = exact;
      continue;
    }
    let matched: string | undefined;
    for (const alias of aliases) {
      matched = byUpper.get(alias);
      if (matched) break;
    }
    if (!matched) {
      for (const scaled of scaleVariants) {
        matched = byUpper.get(scaled);
        if (matched) break;
      }
    }
    if (matched) targets[venue] = matched;
  }
  return targets;
}

/** 构建至少命中 1 个目标 DEX 场所的候选清单，TradFi 永续及匹配场所多者优先。 */
export function buildLeadCandidates(
  binance: readonly BinanceContract[],
  dexMarkets: Record<LeadVenue, readonly MarketSpec[]>,
): LeadCandidateView[] {
  const rows: LeadCandidateView[] = [];
  for (const contract of binance) {
    const targets = matchDexTargets(contract, dexMarkets);
    const matchCount = Object.keys(targets).length;
    if (!matchCount) continue;
    rows.push({ ...contract, targets, matchCount });
  }
  return rows.sort((a, b) =>
    b.matchCount - a.matchCount
    || Number(b.contractType === 'TRADIFI_PERPETUAL') - Number(a.contractType === 'TRADIFI_PERPETUAL')
    || Number(b.quoteAsset === 'USDT') - Number(a.quoteAsset === 'USDT')
    || a.symbol.localeCompare(b.symbol));
}

function quantile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  const weight = pos - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

interface StreamTrackerState {
  symbol: string;
  connected: boolean;
  lastError: string | null;
  reconnects: number;
  segmentStart: number | null;
  segId: number;
  ticksCount: number;
  lastTick: QuoteTick | null;
  recentTickMonos: number[];
  exchangeLags: number[];
  ticks: QuoteTick[];
  gridCells: Map<number, { mid: number; segId: number }>;
}

interface EventVenueState {
  status: LeadFollowStatus;
  baseMid: number | null;
  baseMono: number | null;
  followMono: number | null;
  lagMs: number | null;
  maxMoveBps: number | null;
}

interface InternalEvent {
  id: number;
  wallMs: number;
  triggerMono: number;
  bnCrossMono: number;
  preStartMono: number;
  direction: 1 | -1;
  baseMid: number;
  triggerMid: number;
  moveBps: number;
  venues: Partial<Record<LeadVenue, EventVenueState>>;
}

interface VenueStatsInternal {
  followedLags: number[];
  unfollowed: number;
  disconnected: number;
  noData: number;
  cancelled: number;
  pending: number;
  bnLeadCount: number;
  dexLeadCount: number;
  tieCount: number;
}

function upperBound(ticks: readonly QuoteTick[], monoMs: number): number {
  let lo = 0, hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid]!.monoMs <= monoMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastAtOrBefore(ticks: readonly QuoteTick[], monoMs: number, minMono: number): { tick: QuoteTick; nextIdx: number } | null {
  const hi = upperBound(ticks, monoMs);
  if (!hi) return null;
  const tick = ticks[hi - 1]!;
  return tick.monoMs >= minMono ? { tick, nextIdx: hi } : null;
}

/**
 * 实时追踪一次测速会话的所有行情流、同门槛跃动事件、100ms 互相关及近 60 秒相对涨跌幅曲线。
 */
export class LeadTracker {
  readonly id: string;
  readonly config: LeadConfig;
  readonly startedAt: number;
  readonly startMono: number;
  readonly activeVenues: readonly LeadVenue[];

  private finishedAt: number | null = null;
  private finishedMono: number | null = null;
  private finishedReason: 'completed' | 'manual' | 'shutdown' | null = null;
  private lastTriggerMono = -Infinity;
  private nextEventId = 0;
  private gridOriginMono: number | null = null;
  private lastGridIndex = -1;
  private gridRevision = 0;
  private xcorrCache: Partial<Record<LeadVenue, { revision: number; result: { xcorr: LeadXcorrView | null; reason: string | null } }>> = {};

  private readonly streams: Record<LeadSource, StreamTrackerState>;
  private readonly events: InternalEvent[] = [];
  private readonly pendingEvents = new Set<InternalEvent>();
  private readonly venueStats: Partial<Record<LeadVenue, VenueStatsInternal>> = {};

  constructor(id: string, config: LeadConfig, startedAt: number, startMono: number) {
    this.id = id;
    this.config = config;
    this.startedAt = startedAt;
    this.startMono = startMono;
    this.activeVenues = LEAD_VENUES.filter(v => Boolean(config.targets[v]));
    const mk = (symbol: string): StreamTrackerState => ({
      symbol,
      connected: false,
      lastError: null,
      reconnects: 0,
      segmentStart: null,
      segId: 0,
      ticksCount: 0,
      lastTick: null,
      recentTickMonos: [],
      exchangeLags: [],
      ticks: [],
      gridCells: new Map(),
    });
    this.streams = {
      binance: mk(config.binanceSymbol),
      lighter: mk(config.targets.lighter ?? ''),
      rh: mk(config.targets.rh ?? ''),
      entropy: mk(config.targets.entropy ?? ''),
    };
    for (const venue of this.activeVenues) {
      this.venueStats[venue] = {
        followedLags: [],
        unfollowed: 0,
        disconnected: 0,
        noData: 0,
        cancelled: 0,
        pending: 0,
        bnLeadCount: 0,
        dexLeadCount: 0,
        tieCount: 0,
      };
    }
  }

  private gridIndex(monoMs: number): number {
    if (this.gridOriginMono === null) this.gridOriginMono = Math.floor(monoMs / LEAD_GRID_STEP_MS) * LEAD_GRID_STEP_MS;
    return Math.max(0, Math.floor((monoMs - this.gridOriginMono) / LEAD_GRID_STEP_MS));
  }

  private pruneGrid(latestIdx: number): void {
    const cutoff = latestIdx - MAX_GRID_CELLS;
    if (cutoff < 0) return;
    for (const source of LEAD_SOURCES) {
      const cells = this.streams[source].gridCells;
      for (const idx of cells.keys()) {
        if (idx < cutoff) cells.delete(idx);
        else break;
      }
    }
  }

  /** 将所有流上的当前有效报价补齐到当前时刻的 100ms 网格（不跨断线或超过 60s 静默）。 */
  private fillGridUpTo(targetIdx: number, monoMs: number): void {
    if (this.gridOriginMono === null) return;
    const startIdx = Math.max(0, this.lastGridIndex + 1, targetIdx - MAX_GRID_CELLS);
    if (startIdx <= targetIdx) {
      for (let idx = startIdx; idx <= targetIdx; idx++) {
        const cellMono = this.gridOriginMono + idx * LEAD_GRID_STEP_MS;
        for (const source of LEAD_SOURCES) {
          if (source !== 'binance' && !this.config.targets[source]) continue;
          const stream = this.streams[source];
          if (!stream.connected || stream.segmentStart === null || !stream.lastTick) continue;
          if (stream.lastTick.monoMs < stream.segmentStart) continue;
          if (cellMono - stream.lastTick.monoMs > LEAD_BASE_STALE_MS) continue;
          stream.gridCells.set(idx, { mid: stream.lastTick.mid, segId: stream.segId });
          this.gridRevision++;
        }
      }
      this.lastGridIndex = targetIdx;
      this.pruneGrid(targetIdx);
    }
    void monoMs;
  }

  setConnected(source: LeadSource, connected: boolean, monoMs: number, error: string | null = null, reconnects?: number): void {
    if (this.finishedAt !== null) return;
    // 状态切换前把已有在线流补齐到当前网格边界，使断线区间自然留空。
    if (this.gridOriginMono !== null) {
      this.fillGridUpTo(this.gridIndex(monoMs), monoMs);
    }
    const stream = this.streams[source];
    if (reconnects !== undefined) stream.reconnects = reconnects;
    if (connected) {
      const wasDown = !stream.connected;
      stream.connected = true;
      stream.lastError = error;
      if (wasDown || stream.segmentStart === null) {
        stream.segId++;
        stream.segmentStart = monoMs;
      }
    } else {
      stream.connected = false;
      if (error !== null) stream.lastError = error;
      if (stream.segmentStart !== null) {
        stream.segmentStart = null;
        stream.segId++;
      }
      if (source !== 'binance') {
        for (const ev of this.pendingEvents) {
          const vs = ev.venues[source];
          if (vs && vs.status === 'pending') {
            this.transitionVenue(source, vs, 'disconnected');
          }
          this.checkEventSettled(ev);
        }
      }
    }
  }

  private transitionVenue(venue: LeadVenue, state: EventVenueState, nextStatus: LeadFollowStatus, lagMs?: number, followMono?: number): void {
    const stats = this.venueStats[venue];
    if (!stats) return;
    if (state.status === 'pending') stats.pending = Math.max(0, stats.pending - 1);
    state.status = nextStatus;
    if (followMono !== undefined) state.followMono = followMono;
    if (lagMs !== undefined) {
      state.lagMs = lagMs;
      if (stats.followedLags.length < MAX_LAGS_PER_VENUE) stats.followedLags.push(lagMs);
      if (lagMs > 0) stats.bnLeadCount++;
      else if (lagMs < 0) stats.dexLeadCount++;
      else stats.tieCount++;
    } else if (nextStatus === 'unfollowed') stats.unfollowed++;
    else if (nextStatus === 'disconnected') stats.disconnected++;
    else if (nextStatus === 'no_data') stats.noData++;
    else if (nextStatus === 'cancelled') stats.cancelled++;
  }

  private checkEventSettled(ev: InternalEvent): void {
    for (const venue of this.activeVenues) {
      if (ev.venues[venue]?.status === 'pending') return;
    }
    this.pendingEvents.delete(ev);
  }

  /** 推进待判定事件的超时，供定时 loop 与新报价到达时调用。 */
  tickTimeouts(monoMs: number): void {
    if (this.finishedAt !== null) return;
    const gIdx = this.gridOriginMono !== null ? this.gridIndex(monoMs) : -1;
    if (gIdx >= 0) this.fillGridUpTo(gIdx, monoMs);

    for (const ev of [...this.pendingEvents]) {
      const deadline = ev.triggerMono + this.config.maxWaitMs;
      if (monoMs < deadline) continue;
      for (const venue of this.activeVenues) {
        const vs = ev.venues[venue];
        if (vs && vs.status === 'pending') this.transitionVenue(venue, vs, 'unfollowed');
      }
      this.checkEventSettled(ev);
    }
  }

  onTick(source: LeadSource, tick: QuoteTick): void {
    if (this.finishedAt !== null) return;
    if (!(tick.bid > 0 && tick.ask >= tick.bid && tick.mid > 0)) return;
    if (source !== 'binance' && !this.config.targets[source]) return;

    const stream = this.streams[source];
    if (!stream.connected) {
      stream.connected = true;
      stream.lastError = null;
      stream.segId++;
      stream.segmentStart = tick.monoMs;
    } else {
      stream.lastError = null;
      if (stream.segmentStart === null) stream.segmentStart = tick.monoMs;
    }

    // 补全此前时刻的网格再更新当前报价与网格点。
    const gIdx = this.gridIndex(tick.monoMs);
    this.fillGridUpTo(gIdx, tick.monoMs);

    stream.ticksCount++;
    stream.lastTick = tick;
    stream.recentTickMonos.push(tick.monoMs);
    while (stream.recentTickMonos.length && tick.monoMs - stream.recentTickMonos[0]! > 10_000) {
      stream.recentTickMonos.shift();
    }
    if (tick.exchangeMs !== null) {
      stream.exchangeLags.push(tick.wallMs - tick.exchangeMs);
      if (stream.exchangeLags.length > 25) stream.exchangeLags.shift();
    }

    stream.ticks.push(tick);
    const keepBufferMs = Math.max(LEAD_BASE_STALE_MS + LEAD_PRE_WINDOW_MS, this.config.maxWaitMs + this.config.impulseWindowMs) + 5_000;
    while (stream.ticks.length > 2 && tick.monoMs - stream.ticks[1]!.monoMs > keepBufferMs) {
      stream.ticks.shift();
    }
    while (stream.ticks.length > MAX_TICKS_PER_STREAM) {
      stream.ticks.shift();
    }

    // 更新当前 100ms 网格点。
    stream.gridCells.set(gIdx, { mid: tick.mid, segId: stream.segId });
    this.gridRevision++;
    this.lastGridIndex = Math.max(this.lastGridIndex, gIdx);
    this.pruneGrid(gIdx);

    // 清理已超时事件。
    this.tickTimeouts(tick.monoMs);

    if (source !== 'binance') {
      this.updatePendingForVenue(source, tick);
      return;
    }

    this.evaluateBinanceImpulse(tick);
  }

  /** 对静默但仍在线的一档做心跳保活（刷新有效期与网格连续性，不计入报价变更频次）。 */
  confirmAlive(source: LeadSource, monoMs: number, wallMs: number): void {
    if (this.finishedAt !== null) return;
    if (source !== 'binance' && !this.config.targets[source]) return;
    const stream = this.streams[source];
    if (!stream.connected || stream.segmentStart === null || !stream.lastTick) return;
    if (stream.lastTick.monoMs < stream.segmentStart || monoMs <= stream.lastTick.monoMs) return;
    const gIdx = this.gridIndex(monoMs);
    this.fillGridUpTo(gIdx, monoMs);
    const refreshed: QuoteTick = { ...stream.lastTick, monoMs, wallMs };
    stream.lastTick = refreshed;
    stream.ticks.push(refreshed);
    const keepBufferMs = Math.max(LEAD_BASE_STALE_MS + LEAD_PRE_WINDOW_MS, this.config.maxWaitMs + this.config.impulseWindowMs) + 5_000;
    while (stream.ticks.length > 2 && monoMs - stream.ticks[1]!.monoMs > keepBufferMs) {
      stream.ticks.shift();
    }
    while (stream.ticks.length > MAX_TICKS_PER_STREAM) {
      stream.ticks.shift();
    }
    stream.gridCells.set(gIdx, { mid: refreshed.mid, segId: stream.segId });
    this.gridRevision++;
    this.lastGridIndex = Math.max(this.lastGridIndex, gIdx);
    this.pruneGrid(gIdx);
  }

  private updatePendingForVenue(venue: LeadVenue, tick: QuoteTick): void {
    const followBps = this.config.thresholdBps * this.config.followRatio;
    for (const ev of [...this.pendingEvents]) {
      const vs = ev.venues[venue];
      if (!vs || vs.status !== 'pending' || vs.baseMid === null) continue;
      if (tick.monoMs > ev.triggerMono + this.config.maxWaitMs) {
        this.transitionVenue(venue, vs, 'unfollowed');
        this.checkEventSettled(ev);
        continue;
      }
      if (tick.monoMs < ev.preStartMono) continue;
      const move = ev.direction * ((tick.mid - vs.baseMid) / vs.baseMid) * 10_000;
      if (vs.maxMoveBps === null || move > vs.maxMoveBps) vs.maxMoveBps = move;
      if (move >= followBps) {
        const lagMs = Math.round(tick.monoMs - ev.bnCrossMono);
        this.transitionVenue(venue, vs, 'followed', lagMs, tick.monoMs);
        this.checkEventSettled(ev);
      }
    }
  }

  private evaluateBinanceImpulse(tick: QuoteTick): void {
    const bn = this.streams.binance;
    if (tick.monoMs - this.lastTriggerMono < this.config.cooldownMs) return;
    const hardFloorMono = Math.max(
      bn.segmentStart ?? -Infinity,
      Number.isFinite(this.lastTriggerMono) ? this.lastTriggerMono : -Infinity,
    );
    const windowStartMono = Math.max(tick.monoMs - this.config.impulseWindowMs, hardFloorMono);

    let bestBase: QuoteTick | null = null;
    let bestMove = 0;
    let bestIdx = -1;
    let sawWindowBoundary = false;
    for (let i = bn.ticks.length - 1; i >= 0; i--) {
      const candidate = bn.ticks[i]!;
      if (candidate.monoMs < hardFloorMono) break;
      const isCarry = candidate.monoMs < windowStartMono;
      if (isCarry && (sawWindowBoundary || tick.monoMs - candidate.monoMs > LEAD_BASE_STALE_MS)) break;
      const move = ((tick.mid - candidate.mid) / candidate.mid) * 10_000;
      if (Math.abs(move) > Math.abs(bestMove)) {
        bestMove = move;
        bestBase = candidate;
        bestIdx = i;
      }
      if (candidate.monoMs === windowStartMono) sawWindowBoundary = true;
      if (isCarry) break;
    }
    if (!bestBase || Math.abs(bestMove) < this.config.thresholdBps) return;

    const direction: 1 | -1 = bestMove > 0 ? 1 : -1;
    const followBps = this.config.thresholdBps * this.config.followRatio;

    // 1. 找到 Binance 同向变动达到 followBps 的首个时刻（同门槛对齐）。
    let bnCrossMono = tick.monoMs;
    for (let i = bestIdx; i < bn.ticks.length; i++) {
      const pt = bn.ticks[i]!;
      const signedMove = direction * ((pt.mid - bestBase.mid) / bestBase.mid) * 10_000;
      if (signedMove >= followBps) {
        bnCrossMono = pt.monoMs;
        break;
      }
    }

    // 2. 确定公共静默起点 preStartMono（向前回看最多 1500ms，不越过断线或上一事件）。
    const preFloor = Math.max(bnCrossMono - LEAD_PRE_WINDOW_MS, hardFloorMono);
    let preStartMono = bestBase.monoMs;
    if (bestBase.monoMs <= preFloor) {
      // 静默后单跳：Binance 在 [preFloor, bnCrossMono) 内未波动，直接以 preFloor 截断，避免回看数秒旧噪音。
      preStartMono = preFloor;
    } else {
      for (let i = bestIdx - 1; i >= 0; i--) {
        const pt = bn.ticks[i]!;
        if (pt.monoMs < hardFloorMono) break;
        const drift = Math.abs((pt.mid - bestBase.mid) / bestBase.mid) * 10_000;
        if (drift >= 0.25 * followBps) break;
        if (pt.monoMs < preFloor) {
          // 紧邻窗口前的平稳报价落在 60s 有效期内，延续到 preFloor，以免窗口前缀内点差微调丢失 DEX 提前抢跑。
          if (tick.monoMs - pt.monoMs <= LEAD_BASE_STALE_MS) preStartMono = preFloor;
          break;
        }
        preStartMono = pt.monoMs;
      }
    }

    this.lastTriggerMono = tick.monoMs;
    const ev: InternalEvent = {
      id: ++this.nextEventId,
      wallMs: tick.wallMs,
      triggerMono: tick.monoMs,
      bnCrossMono,
      preStartMono,
      direction,
      baseMid: bestBase.mid,
      triggerMid: tick.mid,
      moveBps: bestMove,
      venues: {},
    };

    for (const venue of this.activeVenues) {
      const target = this.streams[venue];
      const stats = this.venueStats[venue]!;
      if (!target.connected || target.segmentStart === null) {
        const vs: EventVenueState = { status: 'no_data', baseMid: null, baseMono: null, followMono: null, lagMs: null, maxMoveBps: null };
        ev.venues[venue] = vs;
        stats.noData++;
        continue;
      }
      const minBaseMono = Math.max(preStartMono - LEAD_BASE_STALE_MS, target.segmentStart);
      const baseAtPre = lastAtOrBefore(target.ticks, preStartMono, minBaseMono);
      const baseAtBest = preStartMono < bestBase.monoMs ? lastAtOrBefore(target.ticks, bestBase.monoMs, minBaseMono) : baseAtPre;
      let chosen = baseAtPre;
      if (!chosen) {
        chosen = baseAtBest;
      } else if (baseAtBest && baseAtBest.tick.monoMs > chosen.tick.monoMs) {
        // 若 (preStartMono, bestBase.monoMs] 内目标场所仅往收敛方向移动而未同向抢跑，刷新为更贴近起爆前的稳态点。
        let preLed = false;
        for (let i = chosen.nextIdx; i < baseAtBest.nextIdx; i++) {
          const pt = target.ticks[i]!;
          const leadMove = direction * ((pt.mid - chosen.tick.mid) / chosen.tick.mid) * 10_000;
          if (leadMove >= 0.25 * followBps) { preLed = true; break; }
        }
        if (!preLed) chosen = baseAtBest;
      }
      if (!chosen) {
        const vs: EventVenueState = { status: 'no_data', baseMid: null, baseMono: null, followMono: null, lagMs: null, maxMoveBps: null };
        ev.venues[venue] = vs;
        stats.noData++;
        continue;
      }
      const baseTick = chosen.tick;

      const vs: EventVenueState = {
        status: 'pending',
        baseMid: baseTick.mid,
        baseMono: baseTick.monoMs,
        followMono: null,
        lagMs: null,
        maxMoveBps: 0,
      };
      stats.pending++;

      // 自 baseTick 之后顺扫至当前触发时刻，检测目标场所是否提前抢跑或同步跟进。
      for (let i = chosen.nextIdx; i < target.ticks.length; i++) {
        const pt = target.ticks[i]!;
        if (pt.monoMs > tick.monoMs) break;
        if (pt.monoMs < preStartMono) continue;
        const move = direction * ((pt.mid - baseTick.mid) / baseTick.mid) * 10_000;
        if (vs.maxMoveBps === null || move > vs.maxMoveBps) vs.maxMoveBps = move;
        if (move >= followBps) {
          const lagMs = Math.round(pt.monoMs - bnCrossMono);
          this.transitionVenue(venue, vs, 'followed', lagMs, pt.monoMs);
          break;
        }
      }
      ev.venues[venue] = vs;
    }

    this.events.push(ev);
    if (this.events.length > LEAD_MAX_EVENTS_VIEW) this.events.shift();
    if (this.activeVenues.some(v => ev.venues[v]?.status === 'pending')) {
      this.pendingEvents.add(ev);
    }
  }

  /** 结束本次测试：所有在途 pending 事件标为 cancelled（不计分母）。 */
  finalize(wallMs: number, monoMs: number, reason: 'completed' | 'manual' | 'shutdown'): void {
    if (this.finishedAt !== null) return;
    this.tickTimeouts(monoMs);
    this.finishedAt = wallMs;
    this.finishedMono = monoMs;
    this.finishedReason = reason;
    for (const ev of [...this.pendingEvents]) {
      for (const venue of this.activeVenues) {
        const vs = ev.venues[venue];
        if (vs && vs.status === 'pending') this.transitionVenue(venue, vs, 'cancelled');
      }
      this.pendingEvents.delete(ev);
    }
  }

  /** 抽取按连续网格下标对齐的 500ms 收益率定长数组（缺失为 NaN），兼顾断线保护与线性扫描性能。 */
  private buildReturnSeries(cells: ReadonlyMap<number, { mid: number; segId: number }>): { minIdx: number; values: Float64Array; count: number } {
    const h = LEAD_RETURN_HORIZON_STEPS;
    if (cells.size < LEAD_XCORR_MIN_SAMPLES + h) return { minIdx: 0, values: new Float64Array(0), count: 0 };
    let firstIdx = Infinity;
    let lastIdx = -Infinity;
    for (const idx of cells.keys()) {
      if (idx < firstIdx) firstIdx = idx;
      if (idx > lastIdx) lastIdx = idx;
    }
    const startIdx = firstIdx + h;
    if (lastIdx < startIdx) return { minIdx: 0, values: new Float64Array(0), count: 0 };
    const values = new Float64Array(lastIdx - startIdx + 1);
    values.fill(Number.NaN);
    let count = 0;
    for (const [idx, cur] of cells) {
      if (idx < startIdx) continue;
      const prev = cells.get(idx - h);
      if (!prev || prev.segId !== cur.segId || !(prev.mid > 0) || !(cur.mid > 0)) continue;
      let continuous = true;
      for (let step = 1; step < h; step++) {
        const midCell = cells.get(idx - step);
        if (!midCell || midCell.segId !== cur.segId) { continuous = false; break; }
      }
      if (!continuous) continue;
      values[idx - startIdx] = (cur.mid - prev.mid) / prev.mid;
      count++;
    }
    return { minIdx: startIdx, values, count };
  }

  /** 计算指定 DEX 场所相对 Binance 的 100ms 网格 500ms 重叠收益率互相关曲线，按网格修订版本缓存。 */
  private computeXcorr(venue: LeadVenue, bnSeries: { minIdx: number; values: Float64Array; count: number }): { xcorr: LeadXcorrView | null; reason: string | null } {
    const cached = this.xcorrCache[venue];
    if (cached && cached.revision === this.gridRevision) return cached.result;

    const save = (result: { xcorr: LeadXcorrView | null; reason: string | null }) => {
      this.xcorrCache[venue] = { revision: this.gridRevision, result };
      return result;
    };

    const bn = this.streams.binance.gridCells;
    const dex = this.streams[venue].gridCells;
    if (bn.size < LEAD_XCORR_MIN_SAMPLES + LEAD_RETURN_HORIZON_STEPS || dex.size < LEAD_XCORR_MIN_SAMPLES + LEAD_RETURN_HORIZON_STEPS) {
      return save({ xcorr: null, reason: '双方连续在线采样不足 5 秒' });
    }
    if (bnSeries.count < LEAD_XCORR_MIN_SAMPLES) {
      return save({ xcorr: null, reason: 'Binance 连续在线采样不足 5 秒' });
    }
    const dexSeries = this.buildReturnSeries(dex);
    if (dexSeries.count < LEAD_XCORR_MIN_SAMPLES) {
      return save({ xcorr: null, reason: `${LEAD_VENUE_NAMES[venue]} 连续在线采样不足 5 秒` });
    }

    const minLagSteps = Math.round(LEAD_XCORR_MIN_LAG_MS / LEAD_GRID_STEP_MS);
    const maxLagSteps = Math.round(LEAD_XCORR_MAX_LAG_MS / LEAD_GRID_STEP_MS);
    const bnArr = bnSeries.values;
    const dexArr = dexSeries.values;

    const points: LeadXcorrPoint[] = [];
    let bestPoint: LeadXcorrPoint | null = null;
    let zeroCorr: number | null = null;
    let zeroSamples = 0;
    let anyPairEnough = false;
    let maxVar = 0;

    for (let k = minLagSteps; k <= maxLagSteps; k++) {
      let n = 0;
      let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
      const offset = bnSeries.minIdx + k - dexSeries.minIdx;
      const lo = Math.max(0, -offset);
      const hi = Math.min(bnArr.length, dexArr.length - offset);
      for (let i = lo; i < hi; i++) {
        const x = bnArr[i]!;
        const y = dexArr[i + offset]!;
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        n++;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
      }
      const lagMs = k * LEAD_GRID_STEP_MS;
      if (n < LEAD_XCORR_MIN_SAMPLES) continue;
      anyPairEnough = true;
      const varX = sumXX - (sumX * sumX) / n;
      const varY = sumYY - (sumY * sumY) / n;
      maxVar = Math.max(maxVar, varX, varY);
      if (varX <= 1e-12 || varY <= 1e-12) continue;
      const corr = Math.max(-1, Math.min(1, (sumXY - (sumX * sumY) / n) / Math.sqrt(varX * varY)));
      const point: LeadXcorrPoint = { lagMs, corr: Number(corr.toFixed(4)), samples: n };
      points.push(point);
      if (lagMs === 0) { zeroCorr = point.corr; zeroSamples = n; }
      if (!bestPoint || point.corr > bestPoint.corr || (point.corr === bestPoint.corr && Math.abs(point.lagMs) < Math.abs(bestPoint.lagMs))) {
        bestPoint = point;
      }
    }

    if (!anyPairEnough) return save({ xcorr: null, reason: '双方重叠在线采样不足 5 秒' });
    if (!bestPoint) return save({ xcorr: null, reason: maxVar <= 1e-12 ? '价格尚未出现波动' : '双方有效波动不足' });
    return save({
      xcorr: {
        peakLagMs: bestPoint.lagMs,
        peakCorr: bestPoint.corr,
        zeroCorr,
        samples: zeroSamples || bestPoint.samples,
        points,
      },
      reason: null,
    });
  }

  private buildSeries(currentMono: number, currentWall: number): LeadSeriesPoint[] {
    if (this.gridOriginMono === null) return [];
    const endIdx = this.gridIndex(currentMono);
    const windowSteps = Math.ceil(LEAD_SERIES_WINDOW_MS / LEAD_GRID_STEP_MS);
    const rawStart = Math.max(0, endIdx - windowSteps);
    const span = Math.floor((endIdx - rawStart) / LEAD_SERIES_STRIDE) * LEAD_SERIES_STRIDE;
    const startIdx = endIdx - span;

    const bases: Partial<Record<LeadSource, number>> = {};
    for (let idx = startIdx; idx <= endIdx; idx += LEAD_SERIES_STRIDE) {
      for (const source of LEAD_SOURCES) {
        if (bases[source] !== undefined) continue;
        const cell = this.streams[source].gridCells.get(idx);
        if (cell && cell.mid > 0) bases[source] = cell.mid;
      }
    }
    if (bases.binance === undefined && this.activeVenues.every(v => bases[v] === undefined)) return [];

    const rows: LeadSeriesPoint[] = [];
    for (let idx = startIdx; idx <= endIdx; idx += LEAD_SERIES_STRIDE) {
      const cellMono = this.gridOriginMono + idx * LEAD_GRID_STEP_MS;
      const wallT = Math.round(currentWall - (currentMono - cellMono));
      const rel = (source: LeadSource): number | null => {
        const base = bases[source];
        const cell = this.streams[source].gridCells.get(idx);
        if (!base || !cell || !(cell.mid > 0)) return null;
        return Number((((cell.mid - base) / base) * 10_000).toFixed(2));
      };
      rows.push({
        t: wallT,
        binance: rel('binance'),
        lighter: this.config.targets.lighter ? rel('lighter') : null,
        rh: this.config.targets.rh ? rel('rh') : null,
        entropy: this.config.targets.entropy ? rel('entropy') : null,
      });
    }
    return rows;
  }

  view(wallMs: number, monoMs: number): LeadSessionView {
    const refWall = this.finishedAt ?? wallMs;
    const refMono = this.finishedMono ?? monoMs;
    if (this.finishedAt === null) this.tickTimeouts(monoMs);

    const elapsedMs = Math.max(0, Math.min(this.config.durationSec * 1_000, Math.round(refMono - this.startMono)));
    const remainingMs = this.finishedAt !== null ? 0 : Math.max(0, this.config.durationSec * 1_000 - elapsedMs);
    const bnMid = this.streams.binance.lastTick?.mid ?? null;

    const streamView = (source: LeadSource): LeadStreamView => {
      const s = this.streams[source];
      const tick = s.lastTick;
      const spreadBps = tick && tick.mid > 0 ? Number((((tick.ask - tick.bid) / tick.mid) * 10_000).toFixed(2)) : null;
      const rateWindowSec = Math.max(1, Math.min(10, Math.max(1, (refMono - this.startMono) / 1000)));
      const recentCount = s.recentTickMonos.filter(t => refMono - t <= 10_000).length;
      const basisBps = source !== 'binance' && tick && bnMid && Math.abs(tick.mid / bnMid - 1) <= LEAD_BASIS_MAX_GAP_PCT
        ? Number((((tick.mid - bnMid) / bnMid) * 10_000).toFixed(2))
        : null;
      return {
        source,
        name: LEAD_SOURCE_NAMES[source],
        symbol: s.symbol,
        connected: s.connected,
        lastError: s.lastError,
        reconnects: s.reconnects,
        ticks: s.ticksCount,
        ticksPerSec: Number((recentCount / rateWindowSec).toFixed(1)),
        bid: tick?.bid ?? null,
        ask: tick?.ask ?? null,
        mid: tick?.mid ?? null,
        spreadBps,
        lastTickAt: tick?.wallMs ?? null,
        exchangeLagMs: median(s.exchangeLags) !== null ? Math.round(median(s.exchangeLags)!) : null,
        basisBps,
      };
    };

    const streams: LeadStreamView[] = [streamView('binance'), ...this.activeVenues.map(v => streamView(v))];
    const bnSeries = this.activeVenues.some(v => !this.xcorrCache[v] || this.xcorrCache[v]!.revision !== this.gridRevision)
      ? this.buildReturnSeries(this.streams.binance.gridCells)
      : { minIdx: 0, values: new Float64Array(0), count: 0 };
    const venues: LeadVenueStatsView[] = this.activeVenues.map(venue => {
      const st = this.venueStats[venue]!;
      const sorted = [...st.followedLags].sort((a, b) => a - b);
      const followed = sorted.length;
      const resolved = followed + st.unfollowed;
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const { xcorr, reason } = this.computeXcorr(venue, bnSeries);
      return {
        venue,
        name: LEAD_VENUE_NAMES[venue],
        symbol: this.config.targets[venue]!,
        followed,
        unfollowed: st.unfollowed,
        disconnected: st.disconnected,
        noData: st.noData,
        cancelled: st.cancelled,
        pending: st.pending,
        followRate: resolved > 0 ? Number((followed / resolved).toFixed(4)) : null,
        bnLeadCount: st.bnLeadCount,
        dexLeadCount: st.dexLeadCount,
        tieCount: st.tieCount,
        bnLeadRate: followed > 0 ? Number((st.bnLeadCount / followed).toFixed(4)) : null,
        medianMs: quantile(sorted, 0.5) !== null ? Math.round(quantile(sorted, 0.5)!) : null,
        meanMs: followed > 0 ? Math.round(sum / followed) : null,
        p25Ms: quantile(sorted, 0.25) !== null ? Math.round(quantile(sorted, 0.25)!) : null,
        p75Ms: quantile(sorted, 0.75) !== null ? Math.round(quantile(sorted, 0.75)!) : null,
        p90Ms: quantile(sorted, 0.90) !== null ? Math.round(quantile(sorted, 0.90)!) : null,
        p95Ms: quantile(sorted, 0.95) !== null ? Math.round(quantile(sorted, 0.95)!) : null,
        minMs: sorted.length ? sorted[0]! : null,
        maxMs: sorted.length ? sorted.at(-1)! : null,
        xcorr,
        xcorrReason: reason,
      };
    });

    const events: LeadEventView[] = [...this.events].reverse().map(ev => {
      const venueViews: Partial<Record<LeadVenue, LeadEventVenueView>> = {};
      for (const venue of this.activeVenues) {
        const vs = ev.venues[venue]!;
        venueViews[venue] = {
          status: vs.status,
          lagMs: vs.lagMs,
          maxMoveBps: vs.maxMoveBps === null ? null : Number(vs.maxMoveBps.toFixed(2)),
        };
      }
      return {
        id: ev.id,
        at: ev.wallMs,
        direction: ev.direction === 1 ? 'up' : 'down',
        baseMid: ev.baseMid,
        triggerMid: ev.triggerMid,
        moveBps: Number(ev.moveBps.toFixed(2)),
        venues: venueViews,
      };
    });

    return {
      id: this.id,
      status: this.finishedAt === null ? 'running' : this.finishedReason === 'completed' ? 'completed' : 'stopped',
      config: this.config,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs,
      remainingMs,
      eventCount: this.nextEventId,
      streams,
      venues,
      events,
      series: this.buildSeries(refMono, refWall),
    };
  }
}
